---
title: Infopark Job Application System - API Services
emoji: 🏢
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---

# Infopark Job Application System - API Services

Welcome to the backend repository for the Infopark Job Application System. This application is architected to seamlessly manage user authentication, data processing, and integrations with generative AI for automating job application workflows.

## Overview

This backend is built with **FastAPI** and is containerized for optimized deployment on [Hugging Face Spaces](https://huggingface.co/spaces) using the Docker SDK. It exposes robust RESTful API endpoints that interface with a SQLite database for persistent record-keeping and leverages Gemini AI for advanced resume processing.

## Key Features
- **User Management & Authentication:** Secure token-based access and session handling.
- **Automated Communication Workflows:** SMTP integration for drafting and sending targeted job application emails to categorized Infopark companies.
- **AI-Powered Processing:** Native integration with Google Gemini AI to analyze candidate credentials and automatically generate sophisticated application letters.
- **Secure File Handling:** Infrastructure for the upload, secure storage, and management of candidate resumes.

## Deployment & Configuration

This project is fully configured for automated deployment via Hugging Face Spaces.

### Environment Secrets
To ensure the application operates correctly in production, the following environment variables must be securely configured within the Hugging Face Space **Settings > Secrets**:

- `GEMINI_API_KEY`: Required for authenticating with the Google GenAI service.

## Local Development

To run the application locally on your machine:

```bash
# Install required dependencies
pip install -r requirements.txt

# Start the uvicorn development server
uvicorn app:app --host 0.0.0.0 --port 7860
```
