# AI-Powered Full-Stack Expense Tracker & Financial Analytics

A production-ready personal finance management application built with **React**, **Django REST Framework (DRF)**, **SimpleJWT**, and **EasyOCR**. 

## Key Features
- **User Authentication & Security**: JWT-based stateless auth, strong password policy, phone OTP account verification, and forgot password recovery.
- **Multi-Tenant Data Isolation**: Database-level query filtering ensuring complete data privacy across individual users.
- **AI OCR Receipt Scanner**: Automatic extraction of merchant name, total amount, and transaction date from receipt images using EasyOCR.
- **Interactive Analytics Dashboard**: Real-time spending analysis using Recharts (monthly trends, category distribution, transaction frequency, and metrics).
- **Expense CRUD & Receipt Preview**: Full expense management with receipt attachments, in-app modal preview, category tags, and search filters.
- **User Profile Management**: In-app account review and secure password update workflows.

---

## Tech Stack
- **Frontend**: React.js, React Router v6, Axios, Recharts, Context API
- **Backend**: Python 3.13, Django 5.x, Django REST Framework, SimpleJWT
- **Database**: SQLite (Development) / PostgreSQL compatible
- **ML / OCR**: EasyOCR, PyTorch, Pillow

---

## Setup & Local Installation

### 1. Backend Setup
```bash
cd backend
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

pip install -r requirements.txt
python manage.py makemigrations
python manage.py migrate
python manage.py runserver