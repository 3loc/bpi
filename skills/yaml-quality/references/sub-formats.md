# Sub-format conventions

YAML serves many sub-formats with their own conventions and
constraints. This is the **expansion point** — add a new section
per sub-format the repo adopts, rather than bloating the main
`SKILL.md`.

## How to use this reference

When picking a sub-format for a new file:

1. Search this file for the sub-format.
2. If found, follow the listed conventions.
3. If the sub-format isn't listed, check whether the repo's existing
   files already use a convention (look in the repo).
4. If brand-new, add a section here documenting the conventions you
   followed, with a one-line rationale linking to the upstream spec.

## Sub-formats adopted in this repo

None yet. Add entries below as the repo adopts kustomize, helm,
GitHub Actions, docker-compose, argo, flux, ansible, etc.

## Sub-format checklist (when adding a new one)

- [ ] Concrete file example in the repo (good + bad pair)
- [ ] One-line rationale + upstream spec link
- [ ] Which yamllint rules to relax (e.g. `document-start` for helm
      templates; `comments-indentation` for tools that emit aligned
      comments)
- [ ] Which quirks the design review must catch (placeholder values,
      secret leakage, indent requirements from the spec, key-order
      requirements)
- [ ] How the format handles multi-document (kustomize + patches,
      helm + dependencies)
- [ ] Whether the format uses flow style (`{key: value}`) or block
      style (block style is the norm; flow style is rare)
