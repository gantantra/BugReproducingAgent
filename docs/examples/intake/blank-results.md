# Search results occasionally render empty

Reported by: QA, staging
Frequency: "maybe 1 in 5, worse on mobile"

## What happens

Open the search page, click the "Verified" filter. Usually three result cards appear.
Sometimes the list renders empty instead, and the console shows:

    applyFilters: results undefined

Reloading fixes it. It never happens on the first load of the day, which makes me think
it is a caching or race issue rather than a data problem.

## What I have ruled out

- Not account-specific: three of us reproduced it.
- Not a permissions issue: the same user sees results after a reload.
