---
name: azerbaijani-ui
description: Language, wording and layout rules for user-facing screens and
  messages. Use whenever adding or changing UI text, screens, PDF documents
  or client notification templates.
---
# Azerbaijani UI

- All text goes in `messages/az.json`; components use translation keys.
  Never hard-code Azerbaijani or English strings in components.
- Use correct Azerbaijani letters (ə, ı, ö, ü, ğ, ş, ç). Never ASCII
  substitutes like "e" for "ə".
- Numbers: decimal comma, space as thousands separator (1 234,50 AZN).
  Dates: DD.MM.YYYY. Times: 24-hour, Asia/Baku.
- Tablet screens (formen): touch targets at least 48 px, one main action
  per screen, works in portrait on a 10-inch tablet.

## Glossary (use these exact terms)
| Term | Meaning |
| --- | --- |
| Formen | Foreman (not "usta") |
| Təmirçi | Mechanic |
| Anbardar | Warehouseman |
| Rəhbərlik | Management (approvers) |
| Kassir | Cashier |
| Mühasib | Bookkeeper |
| İş sifarişi | Job order |
| Qüsur aktı | Defect act / estimate |
| Əlavə akt | Supplementary estimate |
| Təhvil-Təslim aktı | Handover act |
| Mədaxil / Məxaric | Stock receipt / stock issue |
| Alış / Satış | Purchase / sale |
| Silinmə | Write-off |
| İnventarlaşma | Stock count |
| Kontragent | Counterparty (client or supplier) |
| Yürüş | Odometer reading |
