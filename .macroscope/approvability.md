Use Macroscope's default approvability criteria.

Additionally, any pull request that changes product defaults is not auto-approvable and requires human review.

Any pull request that adds or broadens a directive that disables or suppresses a lint,
type-checker, or other static-analysis diagnostic is not auto-approvable and requires
human review. This includes file-level, line-level, and configuration-level overrides.

Any pull request that changes email sanitization, the email rendering iframe, or the
remote-image and tracking policy is not auto-approvable and requires human review.
