# BARQ Downloader — Feedback & Support User Guide
**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Document:** End-User Guide: Feedback, Diagnostics & Troubleshooting  
**Language:** English  

---

## 1. Introduction

BARQ Downloader provides a centralized, privacy-respecting **Feedback & Support Center** directly inside the desktop application.

Whether you encounter a broken download link, want to request an enhancement, inspect system performance, or review self-service troubleshooting guides, the Feedback Center provides all tools in one place.

To access the center, click **"Feedback & Support"** in the sidebar navigation (or press `Ctrl+8`).

---

## 2. Navigating the Feedback Center

The Feedback Center is organized into 4 primary functional tabs:

1. **Report a Bug:** Structured form for documenting software issues, crashes, or download errors.
2. **Suggest a Feature:** Form to propose workflow improvements, engine capabilities, or UI features.
3. **My Reports:** Catalog of all your locally saved bug reports and suggestions.
4. **Troubleshooting & Support:** Self-service diagnostic solutions for everyday downloading scenarios.

At the top of the center, real-time counters display:
- **Total Reports:** Combined count of all records stored locally.
- **Bug Reports:** Number of reported defects.
- **Feature Ideas:** Number of improvement suggestions.
- **Exported Packages:** Count of bundles exported to ZIP or JSON.

---

## 3. How to Report a Bug

1. Click on the **"Report a Bug"** tab.
2. Fill out the form fields:
   - **Bug Title:** A concise headline describing the issue (e.g. *"Download stalls at 99% during file merge"*).
   - **Category:** Choose the area most affected:
     - *Download Stalled / Failed*
     - *Slow Download Speed*
     - *Pause & Resume Failure*
     - *Multi-Segment Acceleration*
     - *Interface / Display Bug*
     - *Browser Extension Bridge*
     - *Application Crash / Freeze*
     - *Other Issue*
   - **Severity Level:** Select *Low*, *Medium*, *High*, or *Critical*.
   - **Description:** Provide a detailed description of what happened and any error codes shown.
   - **Steps to Reproduce (Optional):** List step-by-step instructions so developers can replicate the behavior.
   - **Expected vs. Actual Behavior (Optional):** Clarify what you anticipated versus what actually occurred.
   - **Attach Diagnostics (Checkbox):** Checked by default. Bundles sanitized OS and runtime details with the report.
3. Click **"Save as Draft"** to keep working later, or **"Save Bug Report"** to commit the record to your local database.

---

## 4. How to Suggest a Feature

1. Click on the **"Suggest a Feature"** tab.
2. Fill out:
   - **Feature Title:** Name of the idea (e.g. *"Time-of-day speed limiter"*).
   - **Target Category:** Select *Download Engine*, *User Interface*, *Browser Integration*, *Queue & Scheduling*, *Automation*, or *Other*.
   - **Detailed Description:** Describe how the feature should look and function.
   - **Use Case & Benefit:** Explain how this will improve your daily workflow.
3. Click **"Save Feature Request"**. The item will be given a unique tracking ID (`BARQ-XXXXXX`) and saved to your catalog.

---

## 5. Managing "My Reports"

In the **"My Reports"** tab, you have full control over all your saved feedback:

- **Filter & Search:** Search by report ID or keyword, or filter by type (*Bugs Only*, *Features Only*, *Drafts*, *Saved*, *Exported*).
- **Edit / Inspect:** Click the **Document icon** to open the report modal and update details, edit reproduction steps, or adjust status.
- **Export JSON:** Click the **JSON icon** to save an individual report file.
- **Export ZIP:** Click the **Export icon** to package the report alongside sanitized system diagnostics and scrubbed event logs.
- **Delete:** Click the **Trash icon** to permanently delete a report. You will be prompted with a confirmation dialog.

---

## 6. Self-Service Troubleshooting Guide

Before logging a bug, check the **"Troubleshooting & Support"** tab. It features step-by-step solutions for the most common issues:

### 1. HTTP 403 Forbidden or 404 Not Found
- **Reason:** File hosting links often expire or require session cookies.
- **Solution:** Re-copy a fresh download URL from your browser, or trigger the download directly via the BARQ browser extension so browser headers are passed.

### 2. Slow Speeds
- **Reason:** Single TCP connections can be throttled by remote hosts or ISPs.
- **Solution:** Go to **Settings → Multi-Segment Engine** and increase parallel connections to 8 or 16. Verify that Global Speed Limit is set to 0 (unlimited).

### 3. Pause & Resume Restarts from Zero
- **Reason:** The web host does not support HTTP Range requests (HTTP 206) or changed its content hash.
- **Solution:** BARQ automatically falls back to a clean download from byte 0 to protect you against file corruption. Check "Range Support" in the download details dialog.

### 4. Browser Extension Offline
- **Reason:** The native messaging bridge registry entry may need initialization.
- **Solution:** Open **Settings → Browser Integration** and click **"Register Native Host"**, then restart your browser.

### 5. File Merge Stalls / Antivirus Interruption
- **Reason:** Antivirus background scanning can lock partial chunks when combining multi-segment files.
- **Solution:** Ensure your destination drive has sufficient free disk space (at least double the file size) and add your BARQ download directory to your antivirus exclusions.
