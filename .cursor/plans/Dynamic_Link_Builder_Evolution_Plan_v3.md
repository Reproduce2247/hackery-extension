# Dynamic Link Builder Evolution Plan (v3)

## Core Product Positioning

The extension is fundamentally a **general-purpose navigation, extraction, and action-launching platform**.

It should work on:

- Internal enterprise applications
- ServiceNow
- Jira
- GitHub
- SharePoint
- Wikis
- CRM systems
- Monitoring tools
- Personal websites
- Arbitrary web applications

The base product should remain generic.

Domain-specific intelligence should be provided through optional extension packs (Phase 10).

---

# Guiding Principle

> Users should point at data instead of describing how to extract it.

Most users should never need to understand:

- Regex
- CSS selectors
- DOM traversal
- URL parsing
- JSON configuration

Those remain available for power users but should not be required.

---

# Unified Source Model

```text
Source
├─ Selection
├─ URL
│  ├─ Host
│  ├─ Segment
│  ├─ Parameter Name
│  ├─ Parameter Value
│  └─ Regex Match
├─ Element
│  ├─ Text
│  ├─ Attribute
│  └─ Property
├─ Script
└─ Constant
```

---

# Phase 1: Point-and-Click Source Selection

## Page Picker

Allow users to enter a picker mode.

Hovering highlights elements.
Clicking captures the source.

Internally:

- Store selector/path information
- Store sample value

Visually:

- Show extracted value
- Hide selector complexity by default

---

## URL Picker

Instead of forcing regex:

```regex
/browse/([^/]+)
```

Display:

```text
Host
jira.company.com

Segments
0 = browse
1 = ABC-123

Parameters
project = ABC
```

Users click desired pieces.

---

# Phase 2: First-Class URL Components

Promote URL structure pieces to primary concepts.

## Beginner Sources

- Selected Text
- URL Segment
- Parameter Value
- Parameter Name
- Page Element

## Advanced Sources

- Regex
- JavaScript
- Transform Chains

This prevents users from seeing segments, parameters, regex, and scripts simultaneously.

---

# Phase 3: Candidate Detection Without AI

## Collect Candidates

Potential values:

- Selected text
- Hovered element
- URL segments
- URL parameters
- Page title
- Recognized identifiers

## Pattern Recognition

Examples:

```text
INC0012345
RITM0012345
CHG0012345
ABC-123
Emails
UUIDs
```

## Ranking

```text
Selected Text       +100
Hovered Element      +50
Recognized Pattern   +40
URL Segment          +20
Page Title           +10
```

Display top candidates.

This creates an intelligent feeling without AI.

---

# Phase 4: Right-Click Workflow Evolution

Current:

```text
Right Click
↓
Create Link
↓
Configure
```

Desired:

```text
Right Click
↓
Create Link From This
```

Context determines defaults automatically.

Examples:

- From selection
- From URL
- From segment
- From parameter
- From page element

---

# Phase 5: Human-Friendly Diagnostics

Current diagnostics are developer-oriented.

Add a user-oriented layer.

Instead of:

```text
Host Match = False
```

Show:

```text
This link is unavailable.

Expected:
prod.company.com

Found:
dev.company.com
```

Potential future enhancement:

- Partial regex match visualization
- Highlight unmatched portions
- Suggested fixes

---

# Phase 6: Related Host Discovery

## Observation

The concept is larger than environment switching.

This should be modeled as:

```text
Related Hosts
```

rather than:

```text
Environments
```

because it works for:

- environments
- regions
- tenants
- customer instances
- brands
- staging systems

---

## Discovery Algorithm

Use browser history to discover related hosts.

Potential signals:

### Shared Domain Suffix

Example:

```text
dev.company.com
prod.company.com
```

Shared suffix:

```text
company.com
```

---

### Dot-Separated Similarity

Example:

```text
abc.dev.company.com
abc.prod.company.com
```

Only one segment differs.

High confidence.

---

### Host Length Threshold

Avoid suggesting:

```text
google.com
microsoft.com
```

Simply because portions happen to match.

Require:

- minimum hostname length
- minimum matching segment count

---

### Similarity Threshold

Example:

```text
80% similarity
```

Only consider candidates above threshold.

---

## Important Revision

History frequency should NOT generate a separate link suggestion.

Instead:

A link can contain a variable such as:

```text
Environment
```

or more generally:

```text
Target Host
```

The discovered hosts populate a combobox.

Example:

```text
Open Same Page On:

▼ prod.company.com
  test.company.com
  qa.company.com
  dev.company.com
```

History frequency determines ordering.

Most frequently used related hosts appear first.

This keeps:

- one link definition
- one action
- many possible destinations

rather than exploding into dozens of nearly identical links.

---

# Phase 7: URL Visualization

Useful but potentially overwhelming.

Recommendation:

Show URL decomposition only while selecting sources.

Avoid a permanently visible URL tree.

Temporary contextual picker is preferred.

---

# Phase 8: Live Preview Earlier

Provide preview during creation rather than primarily afterward.

Display:

```text
Source
ABC-123

Generated URL
https://jira.company.com/browse/ABC-123
```

Continuously update.

---

# Phase 9: Usage Analytics

Persist metrics.

Track:

- Created
- Executed
- Matched
- Failed
- Ignored
- Last Used

Possible views:

- Most Used
- Never Matched
- Broken
- Unused 90+ Days

Existing logging can provide the foundation.

---

# Phase 10: Extension Packs

The base product remains generic.

Extension packs add domain awareness.

## ServiceNow Pack

Examples:

- INC
- RITM
- REQ
- CHG
- sys_id
- instance handling

## Jira Pack

Examples:

- Issue keys
- Boards
- Sprints
- Epics

## GitHub Pack

Examples:

- Repositories
- Pull requests
- Issues
- Commits

These packs can add:

- detection patterns
- actions
- recipes
- templates
- context-aware suggestions

without increasing complexity in the core extension.

---

# Simplest Useful Magic Algorithm

```text
Collect Candidates
↓
Collect Related Hosts
↓
Recognize Known Patterns
↓
Apply Installed Extension Rules
↓
Assign Scores
↓
Rank Candidates
↓
Display Suggested Actions
```

No AI required.

No cloud service required.

No training data required.

Just:

- extraction
- pattern recognition
- ranking
- related-host discovery
- sensible defaults

The result feels intelligent while remaining deterministic, explainable, fast, local, and privacy-friendly.
