<!-- Follow CONTRIBUTING.md: lead with a plain-language summary focused on the shipped behavior. -->

## Problem

Closes #NNN
<!-- Keep one "Closes #NNN" line per issue this change fully resolves, so GitHub closes it
when the PR merges into main. Remove this line when the PR only partly addresses an issue. -->
Related issue: #NNN
<!-- Name the accompanying issue that stays open (epic, sub-issue, or partly addressed issue),
or write "N/A" when Closes #NNN above already links it. Always make the Problem summary below
stand on its own. -->

A short plain-language summary: what goes wrong, who it affects, and what this
change does about it. Details come after.

## Approach

Summarize the architectural or behavioral change, why this approach was chosen,
and which surfaces and repositories it affects. Mention an alternative only when
a reviewer would ask about it.

## Validation

Give one summary line per check category and its outcome (for example: automated
tests, signed `.wgt`, simulator, Apple TV comparison, real TV). Name any
required check that was skipped or failed, and include a short output excerpt
only when it explains a failure.
<!-- Keep private domains, hostnames, IPs, local paths, credentials, personal data,
and private media details out of the body and attachments. -->

## Risks

State migration, compatibility, security, operational, or release impact, or
write "None identified".

## Checklist

- [ ] I read and can explain the complete diff.
- [ ] This pull request addresses one concern.

## AI Disclosure

- Harness: exact agent harness or application, or "none"
- Tool(s): exact tool name(s), or "none"
- Model(s): exact model identifier(s) reported by each tool, or "n/a"
- Involvement: Fully AI-generated, human verified | AI-assisted | Human-written, AI-reviewed | No AI used
- Adversarial review: scope, method, findings, and resolutions, or "n/a" when this change does not require independent or adversarial review
