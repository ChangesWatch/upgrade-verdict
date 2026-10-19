# Security policy

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/ChangesWatch/upgrade-verdict/security/advisories/new). Do not include credentials, private repository contents, full lockfiles, or customer identifiers in public Issues.

Supported releases: the latest `v1` release receives security fixes. The Action needs `contents: read` and `pull-requests: write` (for its one comment) and never needs other secrets. It does not check out or execute pull request code.

We aim to acknowledge reports within seven days. Please include a minimal reproducible case and the expected security impact.
