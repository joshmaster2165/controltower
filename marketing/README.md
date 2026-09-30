# Social posts

A daily pipeline that turns the real product into LinkedIn and X posts —
screen recordings of the console, branded cards and diagrams, LinkedIn
carousels — with a human approving each one.

```
Claude routine (daily, 11:00 Toronto)          writes marketing/drafts/<date>.json per ROUTINE.md
   │ pushes claude/social-<date>
   ▼
social-draft workflow                          boots Control Tower with the demo fleet, records the scene,
   │                                           renders cards/carousel (render.mjs), stores media under
   │                                           refs/social/<date>, opens a "📣 Social draft" issue
   ▼
you: edit the text in the issue, add the `approved` label   (or close it to skip the day)
   ▼
social-publish workflow                        posts to the LinkedIn company page and X, comments the links
```

Media lives under `refs/social/*`, not a branch, so clones don't download it.

## Try it locally

```bash
pnpm build && pnpm docs:build                  # ffmpeg and Playwright's Chromium needed too
node marketing/check.mjs marketing/examples/gate.json
node marketing/render.mjs marketing/examples/gate.json /tmp/social-out
DRY_RUN=1 node marketing/publish.mjs <issue-body.md> /tmp/social-out
```

- `scenes.mjs`: the recordings (`airspace`, `trace`, `gate`, `ledger`, `flights`, `inventory`, `website`, `docs`, or your own `steps`)
- `cards.mjs`: card, carousel and video-frame templates
- `ROUTINE.md`: the routine's playbook: angles, voice, brief format. Edit it to steer the content.

## Connect the accounts

Secrets go in the **`social`** environment (Settings → Environments → social). A
platform without secrets is skipped, and the issue still has the text and media
to post by hand.

**LinkedIn company page.** Create an app at developer.linkedin.com, linked to the
Control Tower page. Request the **Community Management API** product (LinkedIn
reviews it). Authorize a page admin with the `w_organization_social` scope.
- `LINKEDIN_ORG_ID`: the number in the page's admin URL (`linkedin.com/company/<id>/admin`)
- `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` and `LINKEDIN_REFRESH_TOKEN`: the refresh token lasts about a year. Alternatively, set `LINKEDIN_ACCESS_TOKEN` alone and replace it every 60 days.
- Optional variable `LINKEDIN_VERSION` (YYYYMM) if the default API version is retired.

**X brand account.** In the X developer console, create an app with **Read and
write** permission, then generate the access token and secret while signed in
as the brand account. Posting media needs API access that includes media
upload.
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`
