Warnings in tests
The filterwarnings = ["error"] setting in pyproject.toml makes warnings fail the test run. This is intentional: warnings in security tests may indicate a regression.
Reporting a vulnerability
Do not report security vulnerabilities in public GitHub issues.

Email the maintainers with:
- A description of the vulnerability.
- Steps to reproduce it, ideally with a failing test.
- Your assessment of its severity and exploitability.
The maintainers aim to acknowledge reports within 72 hours. Coordinated disclosure takes place after a fix is available.

There is no bug bounty program. The maintainers aim to fix valid issues quickly and publicly credit the reporter, unless the reporter requests anonymity.
Related documentation
- [`system-design.md`, section 3](system-design.md#3) — maps security guarantees to the stages that enforce them.
- [`system-design.md`, section 7](system-design.md#7) — explains the failure taxonomy and error codes.
- [`adr/`](adr/) — records decisions that define and constrain the guarantees.
- [`tests/security/`](../tests/security/) — contains the security tests.