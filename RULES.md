# Food Planner rules

This is a personal meal planner for Shane and Bella, hosted on a computer at home. Any device on the home network can use it. It is not the ERP. Keep it small enough that Shane can read and understand every file.

## Scope

- Local network only. Bind the server to `0.0.0.0` so phones and other computers on the LAN can reach it.
- No logins, no accounts, no permissions. Anyone who can reach the URL can read and change the data. That is intentional.
- One household, one SQLite file (`foodPlanner.db`).
- Day-one job: plan meals for the week, keep recipes, build a shopping list, and keep a simple inventory (stock counts, reserved and deducted lots, min/max, locations, freezer packages, and "use soon" flags), with calorie estimates close enough to be useful.

## Deliberately not done

Do not add these unless Shane asks:

- Logins, passwords, users, or access control
- HTTPS / certificates
- Automated backups (backup = copy the SQLite file)
- Multi-tenant or multi-household support
- Cloud hosting, or a public deployment
- An external nutrition / calorie API
- Redundancy, replication, or "production" hardening
- A frontend framework, EJS, or new runtime dependencies
- Automatically adding cooked, canned, or processed output back into stock (they add those lots by hand)
- Tracking leftovers
- Using only part of a freezer package (packages are always pulled whole, because they have to be thawed whole)
- A separate pack-size field on lots (unit prices are worked out from the total price paid and the total grams, or packages)

## Stack and dependencies

- Node.js, Express, TypeScript, better-sqlite3.
- Frontend: plain HTML, CSS, and vanilla web components (custom elements). No React, no EJS, no component framework.
- The only runtime libraries are Express and better-sqlite3. Do not add another dependency without asking Shane first.
- `ncc_ui` is a later option if we want this to share a look with the ERP. Do not depend on it now. Use and extend the CSS already in `public/css/styles.css`.
- Prefer code Shane can follow over clever abstractions. No low-value tests and no edge-case over-design.

## Data

- Dates are stored and shown as ISO `YYYY-MM-DD`.
- SQLite is the source of truth. The live `foodPlanner.db` holds personal data and must not be committed (the repo is public). Gitignore it. Backup is a copy of that file.
- Units are grams only, including liquids. The only other unit is `piece` (for example 3 eggs, or 2 cloves the spice). A piece item has a typical grams-per-piece (eggs about 60 g), so a recipe treats 3 eggs as 180 g.
- Ingredient amounts are pre-cooked (raw) weight in grams wherever possible.
- There is one shared item list for recipes and inventory. Recipes are built from those items, not from free-typed names.
- Recipes are stored proportionally (W/W%). You enter a batch as made (grams and pieces) and type the cooked yield in grams (for example 1000 g chicken curry, or 500 g cooked rice, which is rice + water). Yield is typed, not inferred from raw weights, because cooking changes mass. A side dish is its own recipe, so dishes can be mixed and matched. When you use a recipe, you ask for a cooked quantity (for example 400 g curry); ingredient amounts and kcal scale by `requested_yield / cooked_yield`. A canning or processing day is just a recipe planned on a day (for example 10 L of tomato sauce), with meal type For Stock.
- Calories are napkin math: kcal per 100 g on every item, including piece items once converted to grams. A portion's kcal is the scaled sum of its ingredients. Close is good enough. No nutrition API unless Shane asks.
- Inventory is a running total of lots. Adding a lot records the total price paid (optional; omitted for homestead lots), the total grams, the date added, the storage location (pantry, fridge, freezer, or a short free-text label), the source (store-bought, including bulk from the butcher, or from the homestead: their own chickens, eggs, garden), and a package count where it applies. Unit price per gram, and per package for freezer lots, is worked out from those figures (`total_price / total_g`, and `total_price / package_count`) and is used for grocery-list cost estimates. There is no separate pack-size field. Homestead lots do not need a price and are excluded from cost analysis. The cost and waste focus is expensive store-bought produce, and fewer shopping trips.
- Anything in the freezer is stored as packages, because it has to be thawed whole. Example: one homestead lot of 10200 g of Meatles chicken breasts in 12 packages averaging 850 g. A package's actual weight can be recorded if known; otherwise it is the lot average. Recipes still use grams (for example 850 g chicken). Planning or cooking pulls a whole package from the lot; that package's weight sets the batch size (the recipe is scaled to the package), and anything extra is leftovers, which are not tracked. Deducting or reserving stock removes or holds whole packages from freezer lots. Non-freezer lots stay in grams (or pieces, for piece items such as eggs). Location is also how they see what is in the chest freezer.
- Planned meals reserve stock. A planned dish can be changed or removed up to and including its day, which updates the reservation. Once the day has passed, reserved stock is deducted automatically. When a recipe is added to a day, show whether it can be made from stock that is still available (on-hand minus what other planned dishes have already reserved) or will add items to the grocery list.
- A stock count is always the final source of truth. Cooked leftovers, canned jars, and butchered cuts are not added back automatically; Shane and Bella add those lots by hand, and may mark them homestead. Each item can have min and max stock, to flag restocking and to help judge whether a larger, cheaper store-bought stock is worthwhile.
- The shopping list is generated from the meal plan versus available stock and min levels, with a cost estimate from the calculated store unit prices.
- An item may have a shelf life in days. Lots that have sat too long, or have little life left, are used first. Those items, and any recipe that uses them, are marked "use soon".
- There are no fixed meal times. Each day is a flat list of planned dishes, each with a meal type, shown in this order: Candy, Dinner, Breakfast, Lunch, For Stock (baking and canning).

## Phone

- Bella uses an iPhone 11. Layout is mobile-first for Mobile Safari, then the wider week grid on a computer.
- Tap targets and nav should be usable with a thumb. The seven-day row in the current CSS will not fit a phone; stack days on a narrow screen.

## Running it on the LAN

- Start with `npm run dev` (compile, then `node dist/server.js`).
- Listen on `0.0.0.0`, port `3000`.
- On a Mac, find the IP in System Settings → Network, or run `ipconfig getifaddr en0` (try `en1` if `en0` is empty). On Windows, run `ipconfig` and read the IPv4 address.
- On a phone or another computer, open `http://<that-ip>:3000`. The home computer's firewall must allow port 3000 on the local network.
