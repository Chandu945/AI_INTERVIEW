
import os
import time
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

models = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
]

client = genai.Client(
    api_key=os.environ["GEMINI_API_KEY"],
    http_options=types.HttpOptions(
        timeout=30000,
        retry_options=types.HttpRetryOptions(
            attempts=1
        )
    )
)

try:
    for model in models:
        print(f"\nTesting {model}...", flush=True)
        start = time.monotonic()

        try:
            response = client.models.generate_content(
                model=model,
                contents="Say Hello.",
                config=types.GenerateContentConfig(
                    max_output_tokens=30
                )
            )

            print("SUCCESS:", response.text)
            print(
                "Time:",
                round(time.monotonic() - start, 2),
                "seconds"
            )

        except Exception as e:
            print("FAILED:", type(e).__name__)
            print(str(e)[:500])

finally:
    client.close()
