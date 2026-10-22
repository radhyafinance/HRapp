# Here are your Instructions

## Staff directory for the Radhya Dashboard

`GET /api/staff/directory` (`backend/routes/staff_directory.py`) gives the dashboard
at dashboard.radhyafinance.com the list of people on staff, which it reads about
once an hour to decide each person's pages. It returns only staff whose status is
`active`, `probation` or `notice_period`, so exited staff drop off on the next read.
Each entry has `employee_id`, `name`, `email` (lowercased, trimmed), `department`,
`designation`, `branch` and `status` and nothing else; the response also carries
`generated_at` and `count`.

The caller sends a shared secret in the `X-Ingest-Token` header, compared in
constant time, like the closing endpoints. It uses its own secret,
`STAFF_DIRECTORY_TOKEN`, which must be set to the same value on the HRapp server
and on the dashboard Worker (`wrangler secret put STAFF_DIRECTORY_TOKEN`). If it
is unset, every request gets a 401.
