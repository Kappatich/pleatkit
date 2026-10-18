# Demo CRM: how panels are built

- Data fields keep `data-testid` equal to the field name in kebab-case: `customer.dueDate` is `data-testid="due-date"`,
  `customer.meta.phone` is `data-testid="phone"`, `customer.meta.city` is `data-testid="city"`. Put it on the element
  that shows the value. Keep the ids that are there and give one to every field you add: the app's end-to-end tests
  and support scripts find values by them.
- A value you compute (a total, an average) gets a `data-testid` named after what it shows (`deals-total`).
- A missing value shows "—".
- Money through `formatMoney`, dates through `formatDate` (`@/readonly/format`). Statuses and stages are `Badge`s.
