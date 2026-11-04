"""Create bank statement PDF fixtures with fake amounts only (not user data).

The fixture is written into a temporary test folder, never Supabase or Vercel.
"""
import io
from pathlib import Path
from pypdf import PdfReader, PdfWriter


def plain_pdf():
    cells = [
        (35, 744, "Date"), (125, 744, "Narration"), (345, 744, "Debit"),
        (425, 744, "Credit"), (505, 744, "Balance"),
        (35, 719, "04/11/2026"), (125, 719, "SWIGGY UPI"), (345, 719, "350.00"), (505, 719, "650.00"),
        (35, 695, "05/11/2026"), (125, 695, "SALARY NEFT"), (425, 695, "25000.00"), (505, 695, "25650.00"),
        (35, 672, "06/11/2026"), (125, 672, "SELF TRANSFER"), (345, 672, "500.00"), (505, 672, "25150.00"),
    ]
    content = "\n".join(
        f"BT /F1 10 Tf 1 0 0 1 {x} {y} Tm ({value}) Tj ET"
        for x, y, value in cells
    ).encode("ascii")
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
        f"<< /Length {len(content)} >>\nstream\n" + content.decode("ascii") + "\nendstream",
    ]
    output = "%PDF-1.4\n"
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output += f"{index} 0 obj\n{obj}\nendobj\n"
    xref = len(output)
    output += f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n"
    output += "".join(f"{i:010d} 00000 n \n" for i in offsets[1:])
    output += f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    return output.encode("ascii")


def main():
    folder = Path(__file__).parent / "fixtures"
    folder.mkdir(exist_ok=True)
    raw = plain_pdf()
    (folder / "synthetic-bank.pdf").write_bytes(raw)
    writer = PdfWriter()
    writer.append(PdfReader(io.BytesIO(raw)))
    writer.encrypt(user_password="OnlyForTests123", owner_password="OnlyForTests123", algorithm="AES-128")
    with (folder / "synthetic-bank-encrypted.pdf").open("wb") as out:
        writer.write(out)


if __name__ == "__main__":
    main()
