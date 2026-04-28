from fastapi import APIRouter, HTTPException, Depends, Response
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, date
from bson import ObjectId
import io

router = APIRouter()

LETTER_TYPES = ["appointment", "offer", "promotion", "warning", "experience", "relieving", "increment", "transfer"]

TEMPLATES = {
    "appointment": """APPOINTMENT LETTER

Date: {date}

To,
{name}
{address}

Dear {name},

We are pleased to appoint you as {designation} in the {department} department at Radhya Micro Finance Private Limited, effective {joining_date}.

Your appointment terms are as follows:
- Designation: {designation}
- Department: {department}
- Reporting To: {reporting_to}
- Date of Joining: {joining_date}
- Monthly CTC: Rs. {ctc_monthly}/-
- Employment Type: {employment_type}

This appointment is subject to satisfactory completion of the probation period of 6 months and is governed by the HR Policy of Radhya Micro Finance Private Limited.

Please sign and return a copy of this letter as your acceptance.

Yours sincerely,

For Radhya Micro Finance Private Limited

HR Department
""",
    "offer": """OFFER LETTER

Date: {date}

To,
{name}

Dear {name},

With reference to the interview held on {interview_date}, we are pleased to offer you the position of {designation} in our organization at a CTC of Rs. {ctc_monthly}/- per month.

Kindly confirm your acceptance and expected date of joining at your earliest.

This offer is valid until {expiry_date}.

Yours sincerely,
HR Department
Radhya Micro Finance Private Limited
""",
    "promotion": """PROMOTION LETTER

Date: {date}

To,
{name}
Employee ID: {employee_id}

Dear {name},

We are pleased to inform you that you have been promoted to the position of {new_designation} effective {effective_date}.

Your revised CTC will be Rs. {new_ctc}/- per month.

We appreciate your contributions and look forward to your continued dedication.

Yours sincerely,

For Radhya Micro Finance Private Limited

Managing Director / CEO
""",
    "warning": """WARNING LETTER

Date: {date}

To,
{name}
Employee ID: {employee_id}
Designation: {designation}
Department: {department}

Dear {name},

This letter serves as a formal warning regarding {issue}.

Details of the incident/violation:
{details}

You are advised to immediately improve your conduct/performance. Please note that a repeat of such behavior may result in disciplinary action including termination.

Please acknowledge receipt of this letter.

Yours sincerely,

HR Department
Radhya Micro Finance Private Limited
""",
    "experience": """EXPERIENCE CERTIFICATE

Date: {date}

TO WHOM IT MAY CONCERN

This is to certify that {name} (Employee ID: {employee_id}) was employed with Radhya Micro Finance Private Limited as {designation} in the {department} Department from {joining_date} to {last_working_date}.

During {pronoun} tenure, {name_short} has been found to be sincere, hardworking, and a team player.

We wish {name_pronoun} all the best for future endeavors.

For Radhya Micro Finance Private Limited

HR Department
""",
    "relieving": """RELIEVING LETTER

Date: {date}

To,
{name}
Employee ID: {employee_id}

Dear {name},

With reference to your resignation dated {resignation_date}, we accept the same and relieve you from your duties effective {last_working_date}.

You are relieved from all your duties and responsibilities as {designation} in {department} with effect from {last_working_date}.

We thank you for your services and wish you success in your future endeavors.

Yours sincerely,

For Radhya Micro Finance Private Limited

HR Department
""",
    "increment": """SALARY INCREMENT LETTER

Date: {date}

To,
{name}
Employee ID: {employee_id}

Dear {name},

We are pleased to inform you that based on your performance review, your CTC has been revised as follows:

- Previous CTC: Rs. {old_ctc}/- per month
- Increment: {increment_pct}%
- Revised CTC: Rs. {new_ctc}/- per month
- Effective Date: {effective_date}

We appreciate your contributions to Radhya Micro Finance Private Limited.

Yours sincerely,

HR Department
Radhya Micro Finance Private Limited
""",
}


def letter_to_dict(l):
    l["id"] = str(l.pop("_id"))
    return l


class LetterCreate(BaseModel):
    employee_id: str
    letter_type: str
    custom_fields: dict = {}
    custom_content: Optional[str] = None


@router.post("")
async def create_letter(data: LetterCreate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if data.letter_type not in LETTER_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid letter type. Use: {LETTER_TYPES}")
    emp = await db.employees.find_one({"employee_id": data.employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    emp_name = f"{emp.get('first_name', '')} {emp.get('last_name', '')}"
    default_fields = {
        "name": emp_name,
        "name_short": emp.get("first_name", ""),
        "employee_id": data.employee_id,
        "designation": emp.get("designation", ""),
        "department": emp.get("department", ""),
        "joining_date": emp.get("joining_date", ""),
        "address": emp.get("address", {}).get("current", ""),
        "ctc_monthly": emp.get("salary", {}).get("gross", ""),
        "employment_type": "Full-time Permanent" if emp.get("status") == "active" else "Probation",
        "date": date.today().isoformat(),
        "pronoun": "their",
        "name_pronoun": "them",
    }
    default_fields.update(data.custom_fields)
    template = TEMPLATES.get(data.letter_type, "")
    try:
        content = template.format(**default_fields)
    except KeyError as e:
        content = template
    if data.custom_content:
        content = data.custom_content
    doc = {
        "employee_id": data.employee_id,
        "employee_name": emp_name,
        "letter_type": data.letter_type,
        "content": content,
        "custom_fields": data.custom_fields,
        "created_by": current_user.get("employee_id"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    result = await db.letters.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@router.get("")
async def list_letters(
    employee_id: str = None,
    letter_type: str = None,
    current_user: dict = Depends(get_current_user),
):
    query = {}
    if current_user.get("role") in ["employee", "field_agent"]:
        query["employee_id"] = current_user.get("employee_id")
    elif employee_id:
        query["employee_id"] = employee_id
    if letter_type:
        query["letter_type"] = letter_type
    letters = await db.letters.find(query).sort("created_at", -1).to_list(500)
    return [letter_to_dict(l) for l in letters]


@router.get("/{letter_id}")
async def get_letter(letter_id: str, current_user: dict = Depends(get_current_user)):
    letter = await db.letters.find_one({"_id": ObjectId(letter_id)})
    if not letter:
        raise HTTPException(status_code=404, detail="Not found")
    return letter_to_dict(letter)


@router.get("/{letter_id}/pdf")
async def download_letter_pdf(letter_id: str, current_user: dict = Depends(get_current_user)):
    letter = await db.letters.find_one({"_id": ObjectId(letter_id)})
    if not letter:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import cm
        from reportlab.lib import colors

        buffer = io.BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=A4,
                                rightMargin=2*cm, leftMargin=2*cm,
                                topMargin=2*cm, bottomMargin=2*cm)
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle('title', parent=styles['Title'], fontSize=14,
                                     textColor=colors.HexColor('#1E2A47'))
        body_style = ParagraphStyle('body', parent=styles['Normal'], fontSize=11,
                                    leading=18, textColor=colors.HexColor('#0F172A'))
        story = [
            Paragraph("RADHYA MICRO FINANCE PRIVATE LIMITED", title_style),
            Spacer(1, 0.5*cm),
            Paragraph(letter.get("letter_type", "").upper().replace("_", " "), styles['Heading2']),
            Spacer(1, 0.5*cm),
        ]
        content = letter.get("content", "")
        for line in content.split("\n"):
            if line.strip():
                story.append(Paragraph(line, body_style))
            else:
                story.append(Spacer(1, 0.3*cm))
        doc.build(story)
        buffer.seek(0)
        filename = f"{letter['letter_type']}_{letter['employee_id']}.pdf"
        return Response(
            content=buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
