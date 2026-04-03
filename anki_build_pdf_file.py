import os
import csv
import json
import time
from dotenv import load_dotenv
from google import genai
from google.genai import types

# 1. Setup
load_dotenv()
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# --- VARIABLES ---
model_name = "gemini-3.1-flash-lite-preview"
skill_file = 'skill_pdf_direct.md'
input_pdf_path = "pdf_coreen_10page.pdf" # Replace with your actual PDF name
output_path = "pdf_extracted_to_anki_format_directly_gemini.csv"

def upload_and_process_pdf(pdf_path):
    """Uploads the PDF using the correct SDK syntax."""
    print(f"☁️  Uploading {pdf_path} to Google File API...")

    # In the new SDK, 'file' is the correct keyword, or pass it directly
    uploaded_file = client.files.upload(file=pdf_path)

    # Wait for processing
    while uploaded_file.state.name == "PROCESSING":
        print(".", end="", flush=True)
        time.sleep(2)
        uploaded_file = client.files.get(name=uploaded_file.name)

    if uploaded_file.state.name == "FAILED":
        raise Exception("PDF processing failed on Google's servers.")

    print(f"\n✅ File ready: {uploaded_file.name}")
    return uploaded_file

def generate_anki_csv(pdf_file_object, filename):
    # Read instructions
    try:
        with open(skill_file, "r", encoding="utf-8") as f:
            system_instructions = f.read()
    except FileNotFoundError:
        print(f"❌ Error: {skill_file} not found.")
        return

    # Since PDFs can be long, we ask the AI to be thorough.
    # Note: For very long PDFs (>15 pages), you might need to specify pages in the prompt.
    print(f"🚀 Analyzing PDF with {model_name}...")

    try:
        start_time = time.time()
        response = client.models.generate_content(
            model=model_name,
            contents=[
                pdf_file_object,
                "Extrait tous les couples de vocabulaire selon skill_pdf_direct.md."
            ],
            config=types.GenerateContentConfig(
                system_instruction=system_instructions,
                response_mime_type="application/json",
                temperature=0.0,
            )
        )
        elapsed = round(time.time() - start_time, 1)

        data = json.loads(response.text)

        # Standardize JSON format
        if isinstance(data, dict):
            for val in data.values():
                if isinstance(val, list):
                    data = val
                    break
            if isinstance(data, dict): data = [data]

        if isinstance(data, list) and len(data) > 0:
            with open(filename, mode='w', newline='', encoding='utf-16') as f:
                fieldnames = ["french", "korean", "phrase"]
                writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter='\t')
                for row in data:
                    if all(key in row for key in fieldnames):
                        writer.writerow(row)

            print(f"✅ Success! {len(data)} cards saved in {elapsed}s.")
        else:
            print("⚠️ No vocabulary found or JSON format was unexpected.")
            print("Raw Response:", response.text[:200])

    except Exception as e:
        print(f"❌ API Error: {e}")

if __name__ == "__main__":
    if os.path.exists(input_pdf_path):
        # 1. Upload
        pdf_obj = upload_and_process_pdf(input_pdf_path)
        # 2. Extract
        generate_anki_csv(pdf_obj, filename=output_path)
        # 3. Clean up (Optional: delete file from Google servers)
        # client.files.delete(name=pdf_obj.name)
    else:
        print(f"❌ PDF not found at {input_pdf_path}")
