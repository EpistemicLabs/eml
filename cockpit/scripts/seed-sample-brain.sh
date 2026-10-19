#!/usr/bin/env bash
# Seed the cockpit's local (dev/test) brain with two sample projects —
# Lighthouse and Orchard — incl. statuses (one superseded), tasks, decisions
# (one past its review date), references, rules, logs, tags and relations.
# Idempotent enough for a fresh brain; re-running on a seeded brain adds
# duplicates (the brain has no upsert). Runs against the host proxy:
#   COCKPIT_URL=http://127.0.0.1:4318 bash cockpit/scripts/seed-sample-brain.sh
# A rejected write stops the script with the server's error (pipefail: a failed
# post fails its `| head` pipeline too, instead of printing a truncated error).
set -eo pipefail
ORIGIN=${COCKPIT_URL:-http://127.0.0.1:4318}
B=$ORIGIN/api/brain
# The host refuses writes without its own Origin (CSRF guard in host/src/http.ts);
# this script writes on the cockpit page's behalf, so it sends that Origin.
post() {
  local r
  r=$(curl -s --fail-with-body -X POST -H 'Content-Type: application/json' -H "Origin: $ORIGIN" "$B$1" -d "$2") \
    || { echo "seed: POST $1 failed: $r" >&2; return 1; }
  printf '%s' "$r"
}
# v0.19: one create route per type (POST /engram/<type>, flat body); the
# server stamps who wrote it, so no source fields; every engram but a status
# has a title, rules need why + agreed, logs their START HERE fields.
eng() { post "/engram/$1" "$2" | head -c 90; echo; }
AGREED='"agreed":"sample brain seed"'

post /object/project '{"id":"lighthouse","name":"Lighthouse","goal":"Ship the v1 of the coastal weather dashboard for the harbour office.","status":"active","status_tracks":"release phase"}' | head -c 120; echo
post /object/project '{"id":"orchard","name":"Orchard","goal":"Plan and plant the community orchard: 40 trees, irrigation, volunteer schedule.","status":"active"}' | head -c 120; echo
# ── Lighthouse ──
eng status '{"scope":"project.lighthouse","content":"Prototype demoed to the harbour master; tide widget works, wind widget shows stale data after 20 minutes.","state":"prototype demoed","next_step":"fix wind data staleness"}'
eng status '{"scope":"project.lighthouse","content":"Wind staleness fixed (cache TTL 2m). Now integrating the buoy feed; go-live target end of month.","state":"buoy feed integration","next_step":"buoy feed parser + go-live checklist"}'
eng task '{"scope":"project.lighthouse","title":"buoy-feed-parser","content":"Write the buoy feed parser (NMEA over HTTP) and map it onto the wind/wave widgets.","status":"active","priority":"high","assignee_id":"assistant"}'
eng task '{"scope":"project.lighthouse","title":"go-live-checklist","content":"Prepare the go-live checklist with the harbour office (accounts, kiosk mode, fallback page).","status":"planned","priority":"normal"}'
eng task '{"scope":"project.lighthouse","title":"kiosk-autostart","content":"Set up kiosk auto-start on the office display (systemd unit + Chromium flags).","status":"planned","priority":"low"}'
eng decision '{"scope":"project.lighthouse","title":"lighthouse-stack","content":"Build the dashboard as a static Vite app fed by a small Node poller, not a full backend — the office display only needs read access and the data sources are public feeds.","rationale":"No auth, no writes, one screen. A poller that writes JSON files keeps the display working even when the poller is down.","alternatives":["Next.js app with API routes","Grafana dashboard"],"review_due_at":"2026-11-20T00:00:00.000Z"}'
eng decision '{"scope":"project.lighthouse","title":"lighthouse-cache-ttl","content":"Wind and wave widgets cache for 2 minutes, tide for 1 hour — matches the feed update cadence.","rationale":"The 20-minute staleness came from a 30-minute cache on a 5-minute feed.","alternatives":["one 5-minute TTL for all widgets","no cache, fetch on every render"],"review_due_at":"2026-08-01T00:00:00.000Z"}'
eng reference '{"scope":"project.lighthouse","title":"met-office-feed-docs","content":"Met Office DataPoint API docs — wind/wave endpoints and rate limits.","source":"https://example.org/datapoint","source_name":"Met Office"}'
eng rule '{"scope":"project.lighthouse","title":"lighthouse-no-secrets-on-display","content":"Nothing on the office display may require a login; all data must be publicly fetchable or pre-rendered by the poller.","applies":"always","why":"The display hangs in a public office; a login on it would leak.",'"$AGREED"'}'
eng log '{"scope":"project.lighthouse","title":"session-2026-09-15-lighthouse-demo","what":"Demo prep for the harbour master.","landed":"Built the tide widget, wired the wind feed, demoed it.","next":"Fix the wind staleness.","open_threads":["wind staleness"],"content":""}'
eng log '{"scope":"project.lighthouse","title":"session-2026-09-20-lighthouse-cache","what":"The wind staleness.","landed":"Found the 30-minute cache on the 5-minute feed; set TTLs per widget.","next":"Buoy feed parser.","content":""}'

# ── Orchard ──
eng status '{"scope":"project.orchard","content":"Site survey done, soil samples sent to the lab. Volunteer list has 14 names.","state":"site surveyed, soil pending","next_step":"pick varieties once soil results are in"}'
eng task '{"scope":"project.orchard","title":"soil-results","content":"Chase the lab for the soil sample results (pH, drainage) — due before ordering trees.","status":"active","priority":"urgent","due_date":"2026-09-30"}'
eng task '{"scope":"project.orchard","title":"irrigation-quote","content":"Get two quotes for drip irrigation covering 40 trees.","status":"planned","priority":"normal"}'
eng decision '{"scope":"project.orchard","title":"orchard-varieties","content":"Plant 60% apple, 25% pear, 15% plum — local heritage varieties from the county nursery.","rationale":"Heritage varieties suit the climate and the community wants recognisable fruit; the nursery offers a volunteer discount.","alternatives":["all apple","mixed exotic varieties"]}'
eng reference '{"scope":"project.orchard","title":"county-nursery-catalogue","content":"County nursery catalogue 2026 — heritage apple/pear/plum list with rootstock notes.","source":"https://example.org/nursery-2026"}'
eng rule '{"scope":"project.orchard","title":"orchard-volunteer-safety","content":"Volunteer days always have one first-aid trained lead on site; tools are counted out and in.","applies":"always","why":"Volunteers handle sharp tools on uneven ground.",'"$AGREED"'}'
eng log '{"scope":"project.orchard","title":"session-2026-09-18-orchard-survey","what":"Site survey.","landed":"Walked the site with the council officer, marked the tree grid, took 6 soil samples.","next":"Wait for the soil results.","content":""}'

idof() { curl -s "$B/list?title=$1&limit=1" | python3 -c "import sys,json;e=json.load(sys.stdin)['engrams'];print(e[0]['id'] if e else '')"; }

for t in weather hardware community planting; do post /object/tag "{\"name\":\"$t\"}" >/dev/null; done
tag() {
  local id; id=$(idof "$1")
  if [[ $(curl -s "$B/engram/$id" | python3 -c "import sys,json;print(json.load(sys.stdin)['type'])") == task ]]; then
    post "/task/$id/track" "{\"tags\":[$2]}" | head -c 60
  else
    post /update "{\"id\":\"$id\",\"patch\":{\"tags\":[$2]}}" | head -c 60
  fi
  echo
}
tag lighthouse-stack '"hardware","weather"'
tag lighthouse-cache-ttl '"weather"'
tag buoy-feed-parser '"weather"'
tag kiosk-autostart '"hardware"'
tag met-office-feed-docs '"weather"'
tag orchard-varieties '"planting","community"'
tag orchard-volunteer-safety '"community"'
tag soil-results '"planting"'
tag irrigation-quote '"planting"'

rel() { post /relate "{\"source_id\":\"$(idof $1)\",\"target_id\":\"$(idof $3)\",\"relation\":\"$2\",\"explanation\":\"seed\"}" | head -c 40; echo; }
rel lighthouse-cache-ttl derived_from session-2026-09-20-lighthouse-cache
rel buoy-feed-parser derived_from lighthouse-stack
rel go-live-checklist blocks kiosk-autostart
rel lighthouse-no-secrets-on-display supports lighthouse-stack
rel met-office-feed-docs related_to lighthouse-cache-ttl
rel orchard-varieties derived_from county-nursery-catalogue
rel soil-results blocks orchard-varieties
rel irrigation-quote related_to orchard-varieties
