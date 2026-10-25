"""Run migrations and security/finance tests in a NEW disposable local PG cluster.

Requires initdb, pg_ctl, psql on PATH (or --pg-bin). Does not read DATABASE_URL,
does not connect to an existing server, and removes its temporary cluster.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
USER = "33333333-3333-3333-3333-333333333333"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, help="Directory containing PostgreSQL binaries")
    parser.add_argument("--verbose", action="store_true", help="Print every passing SQL assertion")
    args = parser.parse_args()
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env["PGCLIENTENCODING"] = "UTF8"

    def binary(name: str) -> str:
        found = str(args.pg_bin / name) if args.pg_bin else shutil.which(name)
        if not found:
            raise SystemExit(f"Missing {name}; install PostgreSQL or pass --pg-bin.")
        return found

    initdb, pg_ctl, psql = (binary(name) for name in ("initdb", "pg_ctl", "psql"))
    # These commands never receive a user-provided host or database URL.
    temp_parent = Path(tempfile.gettempdir()) / "agent-tmp"
    temp_parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tracker-pg-test-", dir=temp_parent) as temporary:
        temp = Path(temporary)
        data, log = temp / "data", temp / "postgres.log"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]

        def command(argv: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
            # File handles avoid Windows server children holding capture pipes
            # open after pg_ctl exits (which would hang communicate()).
            with tempfile.TemporaryFile(dir=temp) as stdout, tempfile.TemporaryFile(dir=temp) as stderr:
                process = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, timeout=120)
                stdout.seek(0)
                stderr.seek(0)
                result = subprocess.CompletedProcess(argv, process.returncode, stdout.read().decode("utf-8", "replace"), stderr.read().decode("utf-8", "replace"))
            if check and result.returncode:
                raise RuntimeError(f"Command failed ({result.returncode}): {argv[0]}\n{result.stdout}\n{result.stderr}")
            return result

        command([initdb, "-D", str(data), "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"])
        started = False
        base = [psql, "-X", "-h", "127.0.0.1", "-p", str(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]

        def sql(statement: str, *, check: bool = True) -> subprocess.CompletedProcess:
            return command(base + ["-A", "-t", "-c", statement], check=check)

        def as_user(statement: str, *, check: bool = True) -> subprocess.CompletedProcess:
            return sql(f"BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='{USER}'; {statement}; COMMIT;", check=check)

        def concurrent(statement: str, count: int) -> list[subprocess.CompletedProcess]:
            with ThreadPoolExecutor(max_workers=min(count, 8)) as pool:
                return list(pool.map(lambda _: as_user(statement, check=False), range(count)))

        def assert_sql(expression: str, label: str) -> None:
            result = sql(f"select test.assert(({expression}),'{label}')")
            print(result.stderr.strip())

        try:
            command([pg_ctl, "-D", str(data), "-l", str(log), "-o", f"-h 127.0.0.1 -p {port} -F", "-w", "start"])
            started = True
            print(sql("select version()").stdout.strip())
            files = [ROOT / "tests" / "bootstrap.sql", *sorted((ROOT / "migrations").glob("*.sql")), ROOT / "tests" / "security_finance.sql", ROOT / "tests" / "reporting_portability.sql", ROOT / "tests" / "assistant.sql"]
            for file in files:
                result = command(base + ["-f", str(file)])
                notices = [line for line in result.stderr.splitlines() if "PASS:" in line]
                print(f"{file.name}: applied; {len(notices)} assertions passed")
                if args.verbose:
                    for notice in notices:
                        print(notice)

            sql(f"insert into auth.users(id) values('{USER}')")
            ids = json.loads(sql(f"select json_object_agg(account_type,id) from public.tracker_accounts where user_id='{USER}'").stdout)
            bank, cash = ids["BANK"], ids["CASH"]
            results = concurrent(f"insert into public.tracker_expenses(account,amount) values({bank},1)", 24)
            assert all(result.returncode == 0 for result in results), "Concurrent expense insert failed: " + "\n".join(result.stderr for result in results if result.returncode)
            assert_sql(f"select balance=-24 from public.tracker_accounts where id={bank}", "24 concurrent expenses have no lost updates")

            results = concurrent(f"insert into public.tracker_transfers(from_account,to_account,amount) values({bank},{cash},2); select pg_sleep(0.02)", 12)
            assert all(result.returncode == 0 for result in results), "Concurrent transfer failed: " + "\n".join(result.stderr for result in results if result.returncode)
            assert_sql(f"select sum(balance)=-24 and min(balance)=-48 and max(balance)=24 from public.tracker_accounts where user_id='{USER}'", "concurrent transfers conserve total and update both accounts")

            with ThreadPoolExecutor(max_workers=8) as pool:
                directions = [(bank, cash), (cash, bank)] * 8
                results = list(pool.map(lambda pair: as_user(f"insert into public.tracker_transfers(from_account,to_account,amount) values({pair[0]},{pair[1]},1); select pg_sleep(0.02)", check=False), directions))
            assert all(result.returncode == 0 for result in results), "Opposing transfers failed: " + "\n".join(result.stderr for result in results if result.returncode)
            assert_sql(f"select sum(balance)=-24 and min(balance)=-48 and max(balance)=24 from public.tracker_accounts where user_id='{USER}'", "opposing concurrent transfers complete without deadlock or lost update")

            sql(f"insert into public.tracker_money_debts(user_id,direction,person_name,amount) values('{USER}','LENT','Concurrency',100)")
            debt = sql(f"select id from public.tracker_money_debts where user_id='{USER}'").stdout.strip()
            results = concurrent(f"insert into public.tracker_debt_payments(debt,amount) values({debt},60); select pg_sleep(0.2)", 2)
            assert sum(result.returncode == 0 for result in results) == 1, "Exactly one racing debt repayment must succeed"
            assert all(result.returncode == 0 or "check constraint" in result.stderr for result in results), "Unexpected debt concurrency error"
            assert_sql(f"select amount_paid=60 from public.tracker_money_debts where id={debt}", "racing debt overpayment rejected without lost update")
            assert_sql(f"select count(*)=1 from public.tracker_debt_payments where debt={debt}", "failed concurrent debt payment leaves no history row")

            sql(f"insert into public.tracker_credit_cards(user_id,name,outstanding) values('{USER}','Concurrency',100)")
            card = sql(f"select id from public.tracker_credit_cards where user_id='{USER}'").stdout.strip()
            results = concurrent(f"select public.tracker_pay_card({card},60,{bank},current_date,'race'); select pg_sleep(0.2)", 2)
            assert sum(result.returncode == 0 for result in results) == 1, "Exactly one racing card payment must succeed"
            assert all(result.returncode == 0 or "check constraint" in result.stderr for result in results), "Unexpected card concurrency error"
            assert_sql(f"select outstanding=40 from public.tracker_credit_cards where id={card}", "racing card overpayment rejected")
            assert_sql(f"select balance=-108 from public.tracker_accounts where id={bank}", "failed racing card payment does not debit account")

            sql(f"insert into public.tracker_recurring_rules(user_id,title,amount,account,next_run) values('{USER}','Concurrency',7,{bank},current_date)")
            results = concurrent("select public.tracker_process_recurring(); select pg_sleep(0.2)", 2)
            assert all(result.returncode == 0 for result in results), "Concurrent recurring process failed"
            assert_sql(f"select count(*)=1 from public.tracker_expenses where user_id='{USER}' and title='Concurrency'", "concurrent recurring processors create exactly one expense")
            assert_sql(f"select balance=-115 from public.tracker_accounts where id={bank}", "recurring concurrency debits once")
            assistant_request = "30000000-0000-0000-0000-000000000001"
            results = concurrent(f"select public.tracker_assistant_prepare('{assistant_request}','CREATE_EXPENSE','{{\"amount\":2,\"category\":\"Food\",\"title\":\"Concurrent assistant\"}}',0.9); select pg_sleep(0.1)", 2)
            assert all(result.returncode == 0 for result in results), "Concurrent assistant prepare failed"
            assert_sql(f"select count(*)=1 from public.tracker_assistant_commands where user_id='{USER}' and client_request_id='{assistant_request}'", "racing assistant submissions share one idempotency record")
            assistant_id = sql(f"select id from public.tracker_assistant_commands where user_id='{USER}' and client_request_id='{assistant_request}'").stdout.strip()
            results = concurrent(f"select public.tracker_assistant_confirm({assistant_id}); select pg_sleep(0.1)", 2)
            assert all(result.returncode == 0 for result in results), "Concurrent assistant confirm failed"
            assert_sql(f"select count(*)=1 from public.tracker_expenses where user_id='{USER}' and title='Concurrent assistant'", "racing confirmations create exactly one expense")
            assert_sql(f"select balance=-117 from public.tracker_accounts where id={bank}", "racing confirmations debit the balance once")
            results = concurrent("select public.tracker_assistant_prepare('30000000-0000-0000-0000-000000000002','CREATE_NOTE','{\"note_content\":\"Concurrent note\"}',0.99,'VOICE_APP'); select pg_sleep(0.1)", 2)
            assert all(result.returncode == 0 for result in results), "Concurrent assistant note failed"
            assert_sql(f"select count(*)=1 from public.tracker_assistant_notes where user_id='{USER}' and content='Concurrent note'", "racing note submissions create exactly one note")
            sql(f"insert into public.tracker_bills(user_id,title,amount,due_date) values('{USER}','Concurrency notice',5,current_date)")
            results = concurrent("select public.tracker_sync_notifications(); select pg_sleep(0.1)", 2)
            assert all(result.returncode == 0 for result in results), "Concurrent notification sync failed"
            assert_sql(f"select count(*)=1 from public.tracker_notifications where user_id='{USER}' and kind='BILL'", "concurrent notification sync creates one deduplicated alert")

            as_user("insert into test.saved values('race_backup',public.tracker_export_backup())")
            before_count = int(sql(f"select count(*) from public.tracker_expenses where user_id='{USER}'").stdout.strip())
            with ThreadPoolExecutor(max_workers=2) as pool:
                held = waiting = False
                restore = pool.submit(as_user, "set local application_name='tracker_restore_race'; select public.tracker_restore_backup((select data from test.saved where label='race_backup'),true); select pg_sleep(1)")
                for _ in range(80):
                    held = sql("select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='tracker_restore_race' and l.locktype='advisory' and l.granted)").stdout.strip() == "t"
                    if held:
                        break
                    time.sleep(0.02)
                assert held, "Restore did not acquire the user write lock"
                assert_sql(f"select count(*)=1 from public.tracker_accounts where id={bank}", "uncommitted restore exposes the complete previous account snapshot")
                writer = pool.submit(as_user, "set local application_name='tracker_write_race'; insert into public.tracker_expenses(title,amount) values('Queued during restore',3)")
                for _ in range(40):
                    waiting = sql("select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='tracker_write_race' and l.locktype='advisory' and not l.granted)").stdout.strip() == "t"
                    if waiting:
                        break
                    time.sleep(0.01)
                assert waiting, "Concurrent CRUD did not wait for restore's user lock"
                restore.result()
                writer.result()
            assert_sql(f"select count(*)={before_count+1} from public.tracker_expenses where user_id='{USER}'", "CRUD queued behind restore persists without lost writes")
            assert_sql(f"select count(*)=1 from public.tracker_expenses where user_id='{USER}' and title='Queued during restore'", "queued expense appears exactly once after restore")
            sql(f"delete from auth.users where id='{USER}'")
            assert_sql(f"select count(*)=0 from public.tracker_accounts where user_id='{USER}'", "Auth user deletion cascades populated financial graph")
            print("PASS: migrations, security/finance SQL, and multi-connection concurrency tests")
        finally:
            if started:
                command([pg_ctl, "-D", str(data), "-m", "immediate", "-w", "stop"])


if __name__ == "__main__":
    main()
