"""Proven resume template generator (reportlab Platypus).

Usage:
    python resume_generator.py [out.pdf] [data.json]

The optional data.json (same dir as the output) may override the default
person. All library calls below are verified against the installed
reportlab; do NOT rename the styles used here ('Title', 'Heading1',
'Heading2', 'BodyText', 'Normal', 'Bullet' all exist in
getSampleStyleSheet() — there is NO 'Heading' style).

Runs on Python 3.14 + reportlab. Never uses JS/npm.
"""
import json
import os
import sys

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    HRFlowable,
)

DEFAULT = {
    "name": "John Doe",
    "title": "Software Engineer",
    "contacts": [
        "johndoe@example.com",
        "+1 (123) 456-7890",
        "New York, NY",
        "linkedin.com/in/johndoe",
    ],
    "summary": (
        "A passionate software engineer with 5+ years of experience "
        "designing scalable web applications and leading cross-functional "
        "teams to on-time delivery."
    ),
    "experience": [
        {
            "role": "Senior Software Engineer",
            "org": "Tech Corp",
            "dates": "2021 - Present",
            "points": [
                "Led design and rollout of a microservices platform serving 2M users.",
                "Cut cloud spend by 30% through caching and query optimization.",
            ],
        },
        {
            "role": "Software Engineer",
            "org": "Startup Labs",
            "dates": "2019 - 2021",
            "points": [
                "Built real-time dashboards in Python and React.",
                "Introduced CI/CD, reducing release time from days to hours.",
            ],
        },
    ],
    "education": [
        {"degree": "BSc Computer Science", "org": "University of Tech", "dates": "2015 - 2019"}
    ],
    "skills": ["Python", "JavaScript", "SQL", "Git", "Docker", "AWS"],
    "photo": "profile.jpg",
}

ACCENT = colors.HexColor("#1F4E78")


def build_styles():
    base = getSampleStyleSheet()
    title = base["Title"].clone("RT")
    title.fontSize = 22
    title.textColor = ACCENT
    title.spaceAfter = 4
    h1 = base["Heading1"].clone("RH1")
    h1.fontSize = 13
    h1.textColor = ACCENT
    h1.spaceBefore = 10
    h1.spaceAfter = 4
    h2 = base["Heading2"].clone("RH2")
    h2.fontSize = 11
    h2.textColor = colors.black
    h2.spaceBefore = 4
    h2.spaceAfter = 1
    normal = base["Normal"]
    normal.leading = 13
    bullet = base["Bullet"]
    bullet.leading = 13
    return {"title": title, "h1": h1, "h2": h2, "normal": normal, "bullet": bullet}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "resume.pdf"
    data_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(out) or ".", "resume_data.json")
    data = dict(DEFAULT)
    if os.path.exists(data_path):
        with open(data_path, "r", encoding="utf-8") as fh:
            over = json.load(fh)
        if isinstance(over, dict):
            data.update(over)

    st = build_styles()
    doc = SimpleDocTemplate(
        out,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=data["name"],
    )
    story = []

    story.append(Paragraph(data["name"], st["title"]))
    story.append(Paragraph(data["title"], st["h2"]))
    story.append(Spacer(1, 2 * mm))

    contact_cells = [[Paragraph(c, st["normal"]) for c in data["contacts"]]]
    contact_table = Table(contact_cells, colWidths=[44 * mm, 44 * mm, 44 * mm, 44 * mm])
    contact_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("LEFTPADDING", (0, 0), (-1, -1), 2),
                ("RIGHTPADDING", (0, 0), (-1, -1), 2),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    story.append(contact_table)
    story.append(Spacer(1, 3 * mm))

    photo = data.get("photo")
    if photo and os.path.exists(photo):
        try:
            from reportlab.platypus import Image

            story.append(Image(photo, width=22 * mm, height=28 * mm))
        except Exception:
            pass
    else:
        # Placeholder avatar: a simple filled circle (no external image needed).
        from reportlab.platypus import Flowable

        class Avatar(Flowable):
            def __init__(self, w=22 * mm, h=28 * mm):
                super().__init__()
                self.width = w
                self.height = h

            def draw(self):
                self.canv.setFillColor(ACCENT)
                self.canv.circle(self.width / 2, self.height / 2, 9 * mm, fill=1)
                self.canv.setFillColor(colors.white)
                self.canv.setFont("Helvetica-Bold", 11)
                initials = "".join(w[0] for w in data["name"].split()[:2]).upper()
                self.canv.drawCentredString(self.width / 2, self.height / 2 - 4, initials)

        story.append(Avatar())

    def section(title):
        story.append(Paragraph(title, st["h1"]))
        story.append(HRFlowable(width="100%", thickness=0.6, color=ACCENT))

    section("Summary")
    story.append(Paragraph(data["summary"], st["normal"]))
    story.append(Spacer(1, 2 * mm))

    section("Experience")
    for job in data["experience"]:
        story.append(Paragraph(f"{job['role']} — {job['org']}", st["h2"]))
        story.append(Paragraph(job["dates"], st["normal"]))
        for point in job["points"]:
            story.append(Paragraph(f"• {point}", st["bullet"]))
    story.append(Spacer(1, 2 * mm))

    section("Education")
    for edu in data["education"]:
        story.append(Paragraph(f"{edu['degree']} — {edu['org']}", st["h2"]))
        story.append(Paragraph(edu["dates"], st["normal"]))
    story.append(Spacer(1, 2 * mm))

    section("Skills")
    skill_text = ", ".join(data["skills"])
    story.append(Paragraph(skill_text, st["normal"]))

    doc.build(story)
    print(f"PDF created at: {out} ({os.path.getsize(out)} bytes)")
    print("DONE_OK")


if __name__ == "__main__":
    main()
