# GitHub Pages deployment

SAFAST is built from `web/` with Vite and deployed from `web/dist` by
`.github/workflows/pages.yml`.

## Required repository settings

1. Open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open **Settings → Environments → github-pages**.
4. Under **Deployment branches and tags**, allow the default branch `main`:
   - choose **Selected branches and tags** and add branch `main`, or
   - choose **No restriction**.
5. Remove the obsolete rule that only allows `agent/single-page-web-app`.
6. Run **Actions → Deploy SAFAST to GitHub Pages → Run workflow**.

The public site is expected at:

`https://netzerolabs.github.io/safast/`

## Diagnosing the known branch-rule failure

The following error means repository settings still restrict Pages deployment
to the old feature branch; editing or rerunning the workflow alone cannot
change that repository-level rule:

```text
Invalid deployment branch ... Deployments are only allowed from
agent/single-page-web-app
```

The build artifact is valid when the `build` job is green. The remaining fix is
to allow `main` in the `github-pages` environment and use GitHub Actions as the
Pages publishing source.
