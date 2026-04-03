import os
from dotenv import load_dotenv
from google import genai

# This loads the variables from your .env file into the system environment
load_dotenv()

# Retrieve the key
api_key = os.getenv("GEMINI_API_KEY")

client = genai.Client(api_key=api_key)

response = client.models.generate_content(
    model="gemini-3-flash-preview",
    contents="Explain how AI works in a few words",
)

print(response.text)
