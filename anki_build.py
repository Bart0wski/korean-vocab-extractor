import os
import csv
import json
import math
import time
from dotenv import load_dotenv
from google import genai
from google.genai import types

# 1. Load environment variables
load_dotenv()

# 2. Setup Client with a global timeout to prevent "un-killable" freezes
client = genai.Client(
    api_key=os.getenv("GEMINI_API_KEY")
)

# Config gemini models and skill
model_name = "gemini-3.1-flash-lite-preview"
skill_file = 'skill_pdf_cdr.md'

input_path = "pdf_coreen_10page_extracted.txt"
output_path = "pdf_extracted_to_anki_format.csv"

def read_input_file(filepath):
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read().strip()
        if not content:
            return None
        print(f"📖 Successfully read {len(content)} characters from {filepath}.")
        return content
    except Exception as e:
        print(f"❌ Error reading file: {e}")
        return None

def generate_anki_csv(input_text, filename="anki_korean.csv"):
    try:
        with open(skill_file, "r", encoding="utf-8") as f:
            system_instructions = f.read()
    except FileNotFoundError:
        print(f"❌ Error: {skill_file} not found.")
        return

    lines = input_text.splitlines()
    num_lines = len(lines)

    # Increase chunk count to 10 for smaller, safer "bites"
    chunk_count = 2 if num_lines > 100 else 1
    lines_per_chunk = math.ceil(num_lines / chunk_count)
    chunks = ["\n".join(lines[i : i + lines_per_chunk]) for i in range(0, num_lines, lines_per_chunk)]

    print(f"📖 Total lines: {num_lines}. Processing in {len(chunks)} chunks.")

    all_data = []

    for idx, chunk in enumerate(chunks):
        print(f"\n🚀 Processing chunk {idx + 1}/{len(chunks)}...")

        try:
            start_time = time.time()
            response = client.models.generate_content(
                model=model_name,
                contents=f"EXTRACT ALL VOCABULARY FROM THIS SECTION:\n\n{chunk}",
                config=types.GenerateContentConfig(
                    system_instruction=system_instructions,
                    response_mime_type="application/json",
                    temperature=0.0,
                )
            )
            elapsed = round(time.time() - start_time, 1)

            chunk_data = json.loads(response.text)

            # Normalize list extraction
            if isinstance(chunk_data, dict):
                for val in chunk_data.values():
                    if isinstance(val, list):
                        chunk_data = val
                        break

            if isinstance(chunk_data, list):
                all_data.extend(chunk_data)
                print(f"   ✅ Done in {elapsed}s. Found {len(chunk_data)} cards.")

            # Mandatory 10s pause to respect Rate Limits and prevent socket hanging
            if idx < len(chunks) - 1:
                print(f"   ⏳ Resting for 10 seconds...")
                time.sleep(10)

        except Exception as e:
            print(f"   ⚠️ Chunk {idx + 1} failed or timed out. Error: {e}")
            print("   Skipping to next chunk...")
            continue

    # Final Save
    if all_data:
        with open(filename, mode='w', newline='', encoding='utf-16') as f:
            fieldnames = ["french", "korean", "phrase"]
            writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter='\t')
            for row in all_data:
                if all(key in row for key in fieldnames):
                    writer.writerow(row)

        print(f"\n🎉 FINISHED! {len(all_data)} cards saved to {filename}")
    else:
        print("❌ Process finished with 0 results.")

if __name__ == "__main__":
    text_to_process = read_input_file(input_path)
    if text_to_process:
        generate_anki_csv(text_to_process, filename=output_path)
