# Security policy

Scrylux is a security tool, so we take reports about its own security seriously. Thank you for
taking the time to report one.

## Supported versions

The latest release line (v0.1.x) receives security fixes. Nothing older does, and `main` is not a supported version: run a release.

## Reporting a vulnerability

**Please do not report a vulnerability in a public issue, pull request or discussion.** A public
report tells everyone about the problem before it can be fixed.

Report it privately, using one of these two channels:

1. **GitHub private vulnerability reporting (preferred).** Open
   <https://github.com/shivamsaraswat/scrylux/security/advisories/new>. Only you and the
   maintainer can see the report until an advisory is published.
2. **Email**, if you don't have a GitHub account: [thecybersapien@protonmail.com](mailto:thecybersapien@protonmail.com).
   Email is not encrypted end to end for most senders, and no PGP key is published. So send a
   **short first message with no exploit details and no proof of concept**, and wait for the
   reply. It will arrange a secure way to share the details, normally a draft GitHub advisory that
   you are invited to.

A good report says:

- the affected version or commit;
- the steps to reproduce it;
- the impact: what an attacker could do.

If a vulnerability is posted publicly anyway, the maintainer hides or deletes the post, moves the
report into a private advisory, and follows up with the reporter there.

## What to expect

- **Acknowledgement** within 7 days of your report.
- **An initial assessment** within 14 days.
- **Coordinated disclosure**: we aim to publish a fix and an advisory within 90 days of your
  report, or sooner once a fix is released. We will agree the timing with you.

Scrylux has a single maintainer. If a target is going to be missed, you will be told.

There is no bug bounty.

## Scope

In scope: the code in this repository, its container image and its CI configuration.

Out of scope: someone else's hosting of Scrylux, and any particular cloud deployment of it.

A vulnerability in a dependency should be reported to that dependency first. Report it to Scrylux
too if the way Scrylux uses the dependency makes it exploitable.

## Safe harbor

Research that follows this policy, in good faith, on a Scrylux install that you run yourself is
welcome, and we will not take legal action over it.

This does not authorize testing anyone else's deployment, or accessing, changing or keeping other
people's data. Research that degrades service for others is not covered.
