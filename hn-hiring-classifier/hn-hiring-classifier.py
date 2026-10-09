#!/usr/bin/env python3
# AI-generated. See PROMPT.md for the prompts and model used.
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "python-dotenv"]
# ///
import html
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

API_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
HN_ITEM_API = "https://hacker-news.firebaseio.com/v0/item/{}.json"
HN_ITEM_ID = re.compile(r"news\.ycombinator\.com/item\?id=(\d+)")

Criteria = dict[str, str]
Json = dict[str, Any]

JOB_FUNCTIONS: Criteria = {
    "ai_ml": "ML, LLM, AI research or applied AI engineering",
    "backend": "Backend, API, database engineering",
    "frontend": "Frontend or web UI engineering",
    "fullstack": "Full-stack engineering",
    "mobile": "iOS or Android engineering",
    "infra_devops": "Infrastructure, DevOps, SRE, platform",
    "data": "Data engineering, analytics, data science",
    "security": "Security engineering",
    "hardware_embedded": "Hardware, embedded, firmware, robotics",
    "design": "Product, UX or visual design",
    "product": "Product management",
    "content_marketing": "Content writing, SEO, content marketing",
    "social_media": "Social media marketing",
    "growth": "Growth or performance marketing",
    "sales": "Sales, account executives, SDRs, sales engineers",
    "customer_success": "Customer success or support",
    "operations": "Operations, finance, HR, recruiting, legal",
    "other": "Any other function",
    "none": "There is no such role in the post",
}

SPEC: dict[str, tuple[str, Criteria]] = {
    "work_mode": (
        "How does this job post say people will work?",
        {
            "onsite": "Must work from an office",
            "hybrid": "Some days in office, some remote",
            "remote": "Fully remote",
            "mixed": "Offers a choice, e.g. onsite OR remote",
            "not_stated": "Work arrangement is not mentioned",
        },
    ),
    "region": (
        "Where is the job located, or where must candidates be based? If a specific city is named, pick that city.",
        {
            "nyc": "New York City area",
            "sf_bay": "San Francisco Bay Area",
            "seattle": "Seattle area",
            "boston": "Boston area",
            "austin": "Austin area",
            "other_us": "Other place in the USA, or USA in general",
            "canada": "Canada",
            "uk": "United Kingdom",
            "europe": "Europe outside the UK",
            "india": "India",
            "latam": "Latin America",
            "apac": "Asia-Pacific outside India",
            "multiple": "Several regions across different countries",
            "anywhere": "Location does not matter",
            "not_stated": "Location is not mentioned",
        },
    ),
    "remote_limit": (
        "If remote work is allowed, where can remote candidates live?",
        {
            "us_only": "Must live in the USA",
            "us_timezones": "Must overlap with US time zones",
            "americas": "North or South America",
            "eu_only": "Must live in Europe",
            "eu_timezones": "Must overlap with European time zones",
            "anywhere": "Anywhere in the world",
            "not_remote": "The job is not remote",
            "not_stated": "Remote is allowed but no limit is mentioned",
        },
    ),
    "openings": (
        "How many distinct roles is this post hiring for?",
        {
            "one": "One role",
            "two_to_five": "Two to five roles",
            "six_plus": "Six or more roles",
        },
    ),
    "job_function_1": (
        "What is the job function of the first distinct role this post hires for? Answer none if there is no first role.",
        JOB_FUNCTIONS,
    ),
    "job_function_2": (
        "What is the job function of the second distinct role this post hires for? Answer none if there is no second role.",
        JOB_FUNCTIONS,
    ),
    "job_function_3": (
        "What is the job function of the third distinct role this post hires for? Answer none if there is no third role.",
        JOB_FUNCTIONS,
    ),
    "job_type": (
        "What type of employment is offered?",
        {
            "full_time": "Full-time",
            "part_time": "Part-time",
            "contract": "Contract or freelance",
            "internship": "Internship",
            "cofounder": "Cofounder or founding partner",
            "not_stated": "Employment type is not mentioned",
        },
    ),
    "salary_bucket": (
        "What is the yearly salary in USD? Use the midpoint of any stated range.",
        {
            "under_20k": "Under 20K USD",
            "20k_50k": "20K to 50K USD",
            "50k_100k": "50K to 100K USD",
            "100k_150k": "100K to 150K USD",
            "150k_200k": "150K to 200K USD",
            "200k_250k": "200K to 250K USD",
            "250k_plus": "Over 250K USD",
            "not_stated": "No salary is mentioned",
        },
    ),
    "currency": (
        "Which currency is the salary stated in?",
        {
            "usd": "US dollars",
            "eur": "Euros",
            "gbp": "British pounds",
            "cad": "Canadian dollars",
            "inr": "Indian rupees",
            "other": "Another currency",
            "not_stated": "No salary or currency is mentioned",
        },
    ),
    "company_stage": (
        "What funding stage is the company at?",
        {
            "seed": "Pre-seed or seed",
            "series_a_b": "Series A or B",
            "series_c_plus": "Series C or later",
            "public": "Publicly traded",
            "bootstrapped": "Bootstrapped or profitable without VC",
            "nonprofit_gov": "Non-profit, academic or government",
            "not_stated": "Stage is not mentioned",
        },
    ),
    "company_size": (
        "How many employees does the company have?",
        {
            "size_1_10": "1 to 10 people",
            "size_11_50": "11 to 50 people",
            "size_51_200": "51 to 200 people",
            "size_201_1000": "201 to 1000 people",
            "size_1000_plus": "More than 1000 people",
            "not_stated": "Size is not mentioned",
        },
    ),
    "industry": (
        "Which industry is the company in?",
        {
            "fintech": "Finance, payments, banking, insurance",
            "health": "Healthcare or medical",
            "biotech": "Biotech or life sciences",
            "devtools": "Developer tools",
            "ai_infra": "AI models, AI infrastructure",
            "security": "Cybersecurity",
            "climate_energy": "Climate, energy, sustainability",
            "crypto": "Crypto or blockchain",
            "defense_gov": "Defense, aerospace, government tech",
            "edtech": "Education",
            "ecommerce_retail": "E-commerce or retail",
            "gaming_media": "Gaming, media, entertainment",
            "enterprise_saas": "Other B2B or enterprise software",
            "consumer": "Other consumer apps",
            "other": "Any other industry",
        },
    ),
    "ai_angle": (
        "How does AI relate to this company?",
        {
            "builds_ai": "Its core product is AI or built on AI models",
            "uses_ai": "Uses AI as a feature or internal tool",
            "not_ai": "AI is not part of the post",
        },
    ),
    "apply_method": (
        "How should candidates apply?",
        {
            "email": "Send an email",
            "careers_page": "Company careers page",
            "ats_link": "Link to an ATS like Greenhouse, Lever, Ashby, Workable",
            "yc_waas": "YC Work at a Startup",
            "other": "Another method, or not mentioned",
        },
    ),
    "poster": (
        "Who wrote this job post?",
        {
            "founder_or_hm": "A founder, executive or hiring manager at the company",
            "inhouse_recruiter": "An in-house recruiter or talent team",
            "agency": "A third-party recruiter or agency",
            "not_stated": "Cannot tell who wrote it",
        },
    ),
}


def build_questions(spec: dict[str, tuple[str, Criteria]]) -> dict[str, Json]:
    return {
        qid: {"type": "choice", "instructions": instructions, "criteria": criteria}
        for qid, (instructions, criteria) in spec.items()
    }


def flatten(answers: dict[str, Json]) -> dict[str, str]:
    return {qid: ans["choice"] for qid, ans in answers.items()}


def classify(text: str, api_key: str) -> Json:
    response = httpx.post(
        API_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": MODEL, "state": text, "questions": build_questions(SPEC)},
        timeout=30,
    )
    response.raise_for_status()
    result: Json = response.json()
    return result


def html_to_text(markup: str) -> str:
    markup = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", markup)
    markup = re.sub(r'(?i)<a\s[^>]*href="([^"]*)"[^>]*>.*?</a>', r"\1", markup)
    markup = re.sub(r"(?i)<(p|br|div|li|h\d)\b[^>]*>", "\n", markup)
    text = html.unescape(re.sub(r"<[^>]+>", "", markup))
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def fetch_hn_item(item_id: str) -> str:
    response = httpx.get(HN_ITEM_API.format(item_id), timeout=15)
    response.raise_for_status()
    item: Json | None = response.json()
    if not item or not item.get("text"):
        sys.exit(f"HN item {item_id} has no text (deleted, or not a comment).")
    if item.get("type") != "comment":
        sys.exit("That is the whole thread. Pass the URL of one job comment instead.")
    return html_to_text(item["text"])


def fetch_url(url: str) -> str:
    hn = HN_ITEM_ID.search(url)
    if hn:
        return fetch_hn_item(hn.group(1))
    response = httpx.get(url, timeout=15, follow_redirects=True)
    response.raise_for_status()
    return html_to_text(response.text)


def read_input(args: list[str]) -> str:
    if not args or args == ["-"]:
        return sys.stdin.read()
    if len(args) == 1 and re.match(r"https?://", args[0]):
        return fetch_url(args[0])
    if len(args) == 1 and Path(args[0]).is_file():
        return Path(args[0]).read_text()
    return " ".join(args)


def main() -> None:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    load_dotenv()
    api_key = os.environ.get("JEV_API_KEY")
    if not api_key:
        sys.exit("JEV_API_KEY is not set (add it to .env)")

    args = sys.argv[1:]
    raw = "--raw" in args
    text = read_input([a for a in args if a != "--raw"]).strip()
    if not text:
        sys.exit("No job text given. Pass a URL, inline text, a file, or stdin.")

    result = classify(text, api_key)
    print(json.dumps(result if raw else flatten(result["answers"]), indent=2))


if __name__ == "__main__":
    main()
