"""Synthetic bank PDF fixtures. Never use a customer's statement in CI."""
import io
from pathlib import Path
from pypdf import PdfReader, PdfWriter


def render_pdf(cells):
    stream = "\n".join(
        f"BT /F1 10 Tf 1 0 0 1 {x} {y} Tm ({text}) Tj ET"
        for x, y, text in cells
    ).encode("ascii")
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
        f"<< /Length {len(stream)} >>\nstream\n" + stream.decode("ascii") + "\nendstream",
    ]
    output = "%PDF-1.4\n"
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output += f"{number} 0 obj\n{obj}\nendobj\n"
    xref = len(output)
    output += f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n"
    output += "".join(f"{offset:010d} 00000 n \n" for offset in offsets[1:])
    output += f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    return output.encode("ascii")


def plain_pdf():
    return render_pdf([
        (35,744,"Date"),(125,744,"Narration"),(345,744,"Debit"),
        (425,744,"Credit"),(505,744,"Balance"),
        (35,719,"04/11/2026"),(125,719,"SWIGGY UPI"),(345,719,"350.00"),(505,719,"650.00"),
        (35,695,"05/11/2026"),(125,695,"SALARY NEFT"),(425,695,"25000.00"),(505,695,"25650.00"),
        (35,672,"06/11/2026"),(125,672,"SELF TRANSFER"),(345,672,"500.00"),(505,672,"25150.00"),
    ])


def recent_seven_days_pdf():
    # A representative banking statement: short-year dates, Chq./Ref.No,
    # Value Dt, Withdrawal Amt, Deposit Amt, closing balance, wrapped narration.
    # Values are fictional, not copied from any customer.
    return render_pdf([
        (35,751,"Recent 7 Days Transactions"),
        (35,729,"Date"),(81,729,"Narration"),(269,729,"Chq./Ref.No."),
        (354,729,"Value"),(380,729,"Dt."),(416,729,"Withdrawal"),
        (465,729,"Amt."),(494,729,"Deposit"),(524,729,"Amt."),
        (553,729,"Closing"),(588,729,"Balance"),
        (35,707,"29/06/26"),(81,707,"UPI-TEST MERCHANT"),(269,707,"0000555512345678"),
        (354,707,"29/06/26"),(416,707,"350.00"),(553,707,"650.00"),
        (81,696,"TRANSACTION FROM PHONE"),
        (35,670,"30/06/26"),(81,670,"SALARY CREDIT"),(269,670,"000055556789"),
        (354,670,"30/06/26"),(494,670,"25000.00"),(553,670,"25650.00"),
    ])



def screenshot_geometry_pdf():
    # Synthetic geometry patterned after a bank statement with centered
    # heading labels and left-aligned rows. No customer data is used.
    return render_pdf([
        (20,755,"Statement of account"),
        (55,740,"Date"),(179,740,"Narration"),(321,740,"Chq./Ref.No."),
        (430,740,"Value Dt"),(495,740,"Withdrawal Amt."),(572,740,"Deposit Amt."),
        (651,740,"Closing Balance"),
        (23,714,"04/09/26"),(80,714,"UPI-TEST COFFEE SHOP"),(321,714,"111122223333"),
        (421,714,"05/09/26"),(505,714,"200.00"),(654,714,"3540.00"),
        (80,703,"TEST PURCHASE"),
        (23,682,"04/09/26"),(80,682,"UPI-TEST MARKET"),(321,682,"111122223334"),
        (421,682,"05/09/26"),(505,682,"300.00"),(654,682,"3240.00"),
        (23,664,"04/09/26"),(80,664,"NEFT TEST REFUND"),(321,664,"111122223335"),
        (421,664,"05/09/26"),(575,664,"60.00"),(654,664,"3300.00"),
    ])

def save_encrypted(raw, path):
    writer = PdfWriter()
    writer.append(PdfReader(io.BytesIO(raw)))
    writer.encrypt(user_password="OnlyForTests123", owner_password="OnlyForTests123", algorithm="AES-128")
    with path.open("wb") as out:
        writer.write(out)


def main():
    folder = Path(__file__).parent / "fixtures"
    folder.mkdir(exist_ok=True)
    basic = plain_pdf()
    (folder / "synthetic-bank.pdf").write_bytes(basic)
    save_encrypted(basic, folder / "synthetic-bank-encrypted.pdf")
    recent = recent_seven_days_pdf()
    (folder / "synthetic-recent-seven-days.pdf").write_bytes(recent)
    save_encrypted(recent, folder / "synthetic-recent-seven-days-encrypted.pdf")
    screenshot_style = screenshot_geometry_pdf()
    (folder / "synthetic-hdfc-centered.pdf").write_bytes(screenshot_style)
    save_encrypted(screenshot_style,folder / "synthetic-hdfc-centered-encrypted.pdf")


if __name__ == "__main__":
    main()
