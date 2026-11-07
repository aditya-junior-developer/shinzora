# Responsive audit — 2026-11-06

Every page in `public/` was opened in a real Chromium build at 1440 px, 834 px, 390 px and measured. Screenshots are in `docs/media/responsive/`; raw measurements are in `docs/responsive-audit.json`.

Checks per page and width: horizontal overflow, the elements causing it, tap-target size, console errors,
failed requests and whether the page rendered visible text.

**87 combinations · 29 clean · 0 with issues**

| Page | Route | Desktop (1440px) | Tablet (834px) | Mobile (390px) |
| --- | --- | --- | --- | --- |
| Home | `/` | no overflow · 1 small target(s) · [shot](docs/media/responsive/home-1440.jpg) | no overflow · 1 small target(s) · [shot](docs/media/responsive/home-834.jpg) | no overflow · 1 small target(s) · [shot](docs/media/responsive/home-390.jpg) |
| 404 | `/404.html` | no overflow · [shot](docs/media/responsive/404-1440.jpg) | no overflow · [shot](docs/media/responsive/404-834.jpg) | no overflow · [shot](docs/media/responsive/404-390.jpg) |
| Offline | `/offline.html` | no overflow · [shot](docs/media/responsive/offline-1440.jpg) | no overflow · [shot](docs/media/responsive/offline-834.jpg) | no overflow · [shot](docs/media/responsive/offline-390.jpg) |
| Download | `/download/` | no overflow · [shot](docs/media/responsive/download-1440.jpg) | no overflow · [shot](docs/media/responsive/download-834.jpg) | no overflow · [shot](docs/media/responsive/download-390.jpg) |
| Documentation | `/docs/` | no overflow · [shot](docs/media/responsive/docs-1440.jpg) | no overflow · [shot](docs/media/responsive/docs-834.jpg) | no overflow · [shot](docs/media/responsive/docs-390.jpg) |
| Install | `/install/` | no overflow · [shot](docs/media/responsive/install-1440.jpg) | no overflow · [shot](docs/media/responsive/install-834.jpg) | no overflow · [shot](docs/media/responsive/install-390.jpg) |
| Install guide | `/install-guide/` | no overflow · 5 small target(s) · [shot](docs/media/responsive/install-guide-1440.jpg) | no overflow · [shot](docs/media/responsive/install-guide-834.jpg) | no overflow · [shot](docs/media/responsive/install-guide-390.jpg) |
| System check | `/system-check/` | no overflow · [shot](docs/media/responsive/system-check-1440.jpg) | no overflow · [shot](docs/media/responsive/system-check-834.jpg) | no overflow · [shot](docs/media/responsive/system-check-390.jpg) |
| Published site (renderer) | `/site/?p=qa-audit` | no overflow · [shot](docs/media/responsive/site-1440.jpg) | no overflow · [shot](docs/media/responsive/site-834.jpg) | no overflow · [shot](docs/media/responsive/site-390.jpg) |
| Terms | `/legal/terms/` | no overflow · 20 small target(s) · [shot](docs/media/responsive/legal-terms-1440.jpg) | no overflow · 20 small target(s) · [shot](docs/media/responsive/legal-terms-834.jpg) | no overflow · 16 small target(s) · [shot](docs/media/responsive/legal-terms-390.jpg) |
| Privacy | `/legal/privacy/` | no overflow · 19 small target(s) · [shot](docs/media/responsive/legal-privacy-1440.jpg) | no overflow · 19 small target(s) · [shot](docs/media/responsive/legal-privacy-834.jpg) | no overflow · 15 small target(s) · [shot](docs/media/responsive/legal-privacy-390.jpg) |
| Refunds | `/legal/refunds/` | no overflow · 16 small target(s) · [shot](docs/media/responsive/legal-refunds-1440.jpg) | no overflow · 16 small target(s) · [shot](docs/media/responsive/legal-refunds-834.jpg) | no overflow · 12 small target(s) · [shot](docs/media/responsive/legal-refunds-390.jpg) |
| Acceptable use | `/legal/acceptable-use/` | no overflow · 15 small target(s) · [shot](docs/media/responsive/legal-acceptable-use-1440.jpg) | no overflow · 15 small target(s) · [shot](docs/media/responsive/legal-acceptable-use-834.jpg) | no overflow · 11 small target(s) · [shot](docs/media/responsive/legal-acceptable-use-390.jpg) |
| Sign in | `/auth/login/` | no overflow · [shot](docs/media/responsive/auth-login-1440.jpg) | no overflow · [shot](docs/media/responsive/auth-login-834.jpg) | no overflow · [shot](docs/media/responsive/auth-login-390.jpg) |
| Sign up | `/auth/signup/` | no overflow · [shot](docs/media/responsive/auth-signup-1440.jpg) | no overflow · [shot](docs/media/responsive/auth-signup-834.jpg) | no overflow · [shot](docs/media/responsive/auth-signup-390.jpg) |
| Forgot password | `/auth/forgot-password/` | no overflow · [shot](docs/media/responsive/auth-forgot-password-1440.jpg) | no overflow · [shot](docs/media/responsive/auth-forgot-password-834.jpg) | no overflow · [shot](docs/media/responsive/auth-forgot-password-390.jpg) |
| Reset password (invalid link) | `/auth/reset-password/` | no overflow · [shot](docs/media/responsive/auth-reset-password-1440.jpg) | no overflow · [shot](docs/media/responsive/auth-reset-password-834.jpg) | no overflow · [shot](docs/media/responsive/auth-reset-password-390.jpg) |
| Verify email | `/auth/verify-email/` | no overflow · [shot](docs/media/responsive/auth-verify-email-1440.jpg) | no overflow · [shot](docs/media/responsive/auth-verify-email-834.jpg) | no overflow · [shot](docs/media/responsive/auth-verify-email-390.jpg) |
| Auth callback | `/auth/callback/` | no overflow · [shot](docs/media/responsive/auth-callback-1440.jpg) | no overflow · [shot](docs/media/responsive/auth-callback-834.jpg) | no overflow · [shot](docs/media/responsive/auth-callback-390.jpg) |
| Admin sign in | `/admin-login/` | no overflow · [shot](docs/media/responsive/admin-login-1440.jpg) | no overflow · [shot](docs/media/responsive/admin-login-834.jpg) | no overflow · [shot](docs/media/responsive/admin-login-390.jpg) |
| Admin console (gate) | `/admin/` | no overflow · [shot](docs/media/responsive/admin-1440.jpg) | no overflow · [shot](docs/media/responsive/admin-834.jpg) | no overflow · [shot](docs/media/responsive/admin-390.jpg) |
| Dashboard · overview | `/app/?view=overview` | no overflow · 1 small target(s) · [shot](docs/media/responsive/app-overview-1440.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-overview-834.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-overview-390.jpg) |
| Dashboard · requests | `/app/?view=requests` | no overflow · 1 small target(s) · [shot](docs/media/responsive/app-requests-1440.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-requests-834.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-requests-390.jpg) |
| Dashboard · billing | `/app/?view=billing` | no overflow · 1 small target(s) · [shot](docs/media/responsive/app-billing-1440.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-billing-834.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-billing-390.jpg) |
| Dashboard · settings | `/app/?view=settings` | no overflow · 1 small target(s) · [shot](docs/media/responsive/app-settings-1440.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-settings-834.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-settings-390.jpg) |
| Dashboard · store | `/app/?view=store` | no overflow · 1 small target(s) · [shot](docs/media/responsive/app-store-1440.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-store-834.jpg) | no overflow · 2 small target(s) · [shot](docs/media/responsive/app-store-390.jpg) |
| Dashboard · orders | `/app/?view=orders` | no overflow · 7 small target(s) · [shot](docs/media/responsive/app-orders-1440.jpg) | no overflow · 8 small target(s) · [shot](docs/media/responsive/app-orders-834.jpg) | no overflow · 8 small target(s) · [shot](docs/media/responsive/app-orders-390.jpg) |
| Dashboard · assistant | `/app/?view=assistant` | no overflow · 5 small target(s) · [shot](docs/media/responsive/app-assistant-1440.jpg) | no overflow · 6 small target(s) · [shot](docs/media/responsive/app-assistant-834.jpg) | no overflow · 6 small target(s) · [shot](docs/media/responsive/app-assistant-390.jpg) |
| Onboarding | `/onboarding/` | no overflow · [shot](docs/media/responsive/onboarding-1440.jpg) | no overflow · [shot](docs/media/responsive/onboarding-834.jpg) | no overflow · [shot](docs/media/responsive/onboarding-390.jpg) |

## Elements that stick out

| Page | Width | Element | Width px | Right edge px |
| --- | --- | --- | --- | --- |
| `/` | 1573 | `div.fx-stage` | 1573 | 1502 |
| `/` | 1573 | `canvas.fx-aurora-canvas` | 1573 | 1502 |
| `/` | 2360 | `div.fx-grid` | 2360 | 1895 |
| `/` | 1573 | `div.fx-vignette` | 1573 | 1502 |
| `/` | 906 | `div.fx-stage` | 906 | 865 |
| `/` | 906 | `canvas.fx-aurora-canvas` | 906 | 865 |
| `/` | 1360 | `div.fx-grid` | 1360 | 1092 |
| `/` | 906 | `div.fx-vignette` | 906 | 865 |
| `/` | 471 | `div.fx-stage` | 471 | 426 |
| `/` | 471 | `canvas.fx-aurora-canvas` | 471 | 426 |
| `/` | 707 | `div.fx-grid` | 707 | 543 |
| `/` | 471 | `div.fx-vignette` | 471 | 426 |
| `/` | 379 | `code` | 379 | 433 |
| `/` | 63 | `span.tok-tag` | 63 | 433 |
| `/docs/` | 187 | `li` | 187 | 1024 |
| `/docs/` | 187 | `a` | 187 | 1024 |
| `/docs/` | 130 | `li` | 130 | 1162 |
| `/docs/` | 130 | `a` | 130 | 1162 |
| `/docs/` | 116 | `li` | 116 | 1286 |
| `/docs/` | 116 | `a` | 116 | 1286 |
| `/docs/` | 89 | `li` | 89 | 1383 |
| `/docs/` | 89 | `a` | 89 | 1383 |
| `/docs/` | 119 | `li` | 119 | 439 |
| `/docs/` | 119 | `a` | 119 | 439 |
| `/docs/` | 182 | `li` | 182 | 629 |
| `/docs/` | 182 | `a` | 182 | 629 |
| `/docs/` | 98 | `li` | 98 | 735 |
| `/docs/` | 98 | `a` | 98 | 735 |
| `/docs/` | 86 | `li` | 86 | 829 |
| `/docs/` | 86 | `a` | 86 | 829 |
| `/app/?view=overview` | 419 | `div.drawer-head` | 419 | 1864 |
| `/app/?view=overview` | 193 | `div` | 193 | 1658 |
| `/app/?view=overview` | 193 | `div.drawer-title` | 193 | 1658 |
| `/app/?view=overview` | 193 | `div#notif-sub.drawer-sub` | 193 | 1658 |
| `/app/?view=overview` | 30 | `button.modal-close` | 30 | 1848 |
| `/app/?view=overview` | 16 | `i` | 16 | 1841 |
| `/app/?view=overview` | 16 | `svg.[object.SVGAnimatedString]` | 16 | 1841 |
| `/app/?view=overview` | 8 | `path.[object.SVGAnimatedString]` | 8 | 1837 |
| `/app/?view=overview` | 419 | `div.drawer-head` | 419 | 1258 |
| `/app/?view=overview` | 193 | `div` | 193 | 1052 |

## Controls smaller than 32 px

| Page | Width | Control | Label | Size |
| --- | --- | --- | --- | --- |
| `/` | 1440 | button | Dismiss install prompt | 30×30 |
| `/` | 834 | button | Dismiss install prompt | 30×30 |
| `/` | 390 | button | Dismiss install prompt | 30×30 |
| `/install-guide/` | 1440 | a | Android | 66×30 |
| `/install-guide/` | 1440 | a | iOS | 42×30 |
| `/install-guide/` | 1440 | a | Windows | 74×30 |
| `/install-guide/` | 1440 | a | macOS | 64×30 |
| `/install-guide/` | 1440 | a | Linux | 53×30 |
| `/legal/terms/` | 1440 | a | Terms | 36×18 |
| `/legal/terms/` | 1440 | a | Privacy | 44×18 |
| `/legal/terms/` | 1440 | a | Refunds | 46×18 |
| `/legal/terms/` | 1440 | a | Acceptable use | 87×18 |
| `/legal/terms/` | 1440 | a | The agreement | 98×16 |
| `/legal/terms/` | 1440 | a | Accounts and eligibility | 146×16 |
| `/legal/terms/` | 1440 | a | AI-generated output | 128×16 |
| `/legal/terms/` | 1440 | a | Your content and your responsibilities | 239×16 |
| `/legal/terms/` | 834 | a | Terms | 36×18 |
| `/legal/terms/` | 834 | a | Privacy | 44×18 |
| `/legal/terms/` | 834 | a | Refunds | 46×18 |
| `/legal/terms/` | 834 | a | Acceptable use | 87×18 |
| `/legal/terms/` | 834 | a | The agreement | 98×16 |
| `/legal/terms/` | 834 | a | Accounts and eligibility | 146×16 |
| `/legal/terms/` | 834 | a | AI-generated output | 128×16 |
| `/legal/terms/` | 834 | a | Your content and your responsibilities | 239×16 |
| `/legal/terms/` | 390 | a | The agreement | 98×16 |
| `/legal/terms/` | 390 | a | Accounts and eligibility | 146×16 |
| `/legal/terms/` | 390 | a | AI-generated output | 128×16 |
| `/legal/terms/` | 390 | a | Your content and your responsibilities | 239×16 |
| `/legal/terms/` | 390 | a | Plans, usage limits and fair use | 198×16 |
| `/legal/terms/` | 390 | a | Payments and verification | 167×16 |
| `/legal/terms/` | 390 | a | Domains, GitHub, Vercel and other provid | 284×16 |
| `/legal/terms/` | 390 | a | Availability of the service | 159×16 |
| `/legal/privacy/` | 1440 | a | Terms | 36×18 |
| `/legal/privacy/` | 1440 | a | Privacy | 44×18 |
| `/legal/privacy/` | 1440 | a | Refunds | 46×18 |
| `/legal/privacy/` | 1440 | a | Acceptable use | 87×18 |
| `/legal/privacy/` | 1440 | a | What we collect | 102×16 |
| `/legal/privacy/` | 1440 | a | Why we collect it | 109×16 |
| `/legal/privacy/` | 1440 | a | AI processing | 87×16 |
| `/legal/privacy/` | 1440 | a | Where data lives | 107×16 |
