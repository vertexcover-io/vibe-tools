# hn-hiring-classifier

Classify an "Ask HN: Who is hiring?" post into 16 categories using TypeSafe's [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) System One model. All 16 questions go in one API call.

Fields: `work_mode`, `region`, `remote_limit`, `openings`, `job_function_1`, `job_function_2`, `job_function_3`, `job_type`, `salary_bucket`, `currency`, `company_stage`, `company_size`, `industry`, `ai_angle`, `apply_method`, `poster`.

## Setup

Add your key to `.env` at the repo root (or export it):

```
JEV_API_KEY=YOUR_KEY
```

## Usage

```bash
uv run hn-hiring-classifier.py "https://news.ycombinator.com/item?id=COMMENT_ID"   # one HN job comment
uv run hn-hiring-classifier.py "https://example.com/careers/backend"             # any job page
uv run hn-hiring-classifier.py "Acme | Backend Engineer | Remote (US) | $150k"    # inline text
uv run hn-hiring-classifier.py post.txt                                          # file
pbpaste | uv run hn-hiring-classifier.py                                         # stdin
```

Add `--raw` to see the full Jev response with probabilities.

HN URLs use the official HN API. They must point to a single comment, not the whole thread.

## Notes

- Job functions use three separate questions (first, second, third role listed), each with a `none` option. A single question with a probability cutoff does not work: Jev puts nearly all the probability on one option.
- Edit `SPEC` in the script to change questions or options.
