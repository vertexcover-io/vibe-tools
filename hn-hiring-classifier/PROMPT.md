# Prompt log — hn-hiring-classifier

**Model / agent:** Claude Opus 5 via Claude Code.

## Prompts

> I want to build a classifier for Ask HN who is hiring using jev system 1 model. What are the ideal filters and categories we can try...

> How can we do multiple job function using jev? don't want to convert each into boolean

> is probabilities of all choices equal to 1?

> Write a small python script that builds a jev script that classifies a given job text into
> work Mode, Region, Remote Limit, Multiple Job Openings, Job Function1, Job Function2, Job Function3,
> Job Type, Salary Bucket (with one option for no salary stated), Currency (one option for Not Stated),
> Company stage, Size, Industry, AI Angle, Apply Method, Who Posted it

## Notes from iteration

- First version used one `job_function` choice question and took the top 3 options above a probability cutoff. A live test showed the probabilities add up to 1 and pile up on one option (0.91 ML, 0.04 backend, 0.03 sales for a 3-role post). Switched to three ordinal questions ("first/second/third role") with a `none` option.
- The region question said `other_us` for "New York, NY". Adding "If a specific city is named, pick that city" fixed it.

## Follow-up

> Extend it to work on a url or inline text -> file option is rare
