# Food Planner plan (v1)

Draft only, for Shane's review. Based on the current `navycuda/foodplanner_v3` scaffolding and his refinements of 2026-11-27. Nothing here has been pushed. All open questions are settled.

## What's already there

- Express 5 + better-sqlite3 + TypeScript (ESM). `npm run dev` runs `tsc && node dist/server.js`.
- `src/server.ts` opens `foodPlanner.db`, serves `dist/web/` and `public/`, and has three page routes: `/`, `/groceries`, `/recipes`. No API routes. Listens on port 3000 (host not set). The database file is empty (0 bytes) and has no schema.
- The home page already renders two weeks, starting Sunday, with a `planner-day` custom element (day name + ISO date only). `src/web/js/groceries.ts` and `recipes.ts` are empty. The Groceries and Recipes pages are nav shells.
- CSS is in place (warm paper palette) with a 7-column week grid and no mobile breakpoints. A larger, commented-out block in the same file looks like an earlier mock and can be mined for ideas, not copied wholesale.
- Date helpers already use ISO `YYYY-MM-DD`. Keep that. Keep the Sunday week start unless Shane changes it.
- The repo is public. `dist/` and an empty `foodPlanner.db` are currently committed. `.gitignore` only ignores `node_modules` and editor folders.

Build on these pages and the `planner-day` component. Do not start a second UI.

## Data model

One SQLite file, `foodPlanner.db`. IDs are integers. Dates are `TEXT` in `YYYY-MM-DD`. Quantities on a non-freezer lot or a recipe line stay in the item's unit (`g` or `piece`). Piece amounts are converted to grams for recipe math and calories (`pieces * grams_per_piece`). Freezer lots are a special case, below.

**items** — the single shared grocery list, used by both recipes and inventory. `id`, `name`, `unit` (`g` or `piece`), `grams_per_piece` (required when unit is `piece`; for example 60 for eggs), `kcal_per_100g` (every item, including piece items after conversion), `min_stock`, `max_stock` (same unit as the item; either may be null), `shelf_life_days` (optional), optional `notes`. Chicken breasts and similar foods stay gram items on the recipe; freezer packaging lives on the lot, not as a change of item unit. The same item can have a freezer lot in packages and a fridge or pantry lot in grams.

**lots** — stock of an item arrives as lots. `id`, `item_id`, `added_on` (ISO date), `location` (`pantry`, `fridge`, `freezer`, or a short free-text label), `source` (`store` or `homestead`), `total_price` (CAD, optional; omitted for homestead), `total_g` (the lot's total grams). Unit prices are not entered; they are worked out from what was recorded: `unit_price_per_g = total_price / total_g`, and for freezer lots also `unit_price_per_package = total_price / package_count`. Those figures are used for grocery-list cost estimates. There is no separate pack-size field. Homestead lots (their own chickens, eggs, garden, including Meatles) do not need a price and are excluded from cost figures. Store lots, including bulk meat from the butcher, carry a total price. Cost and waste focus on expensive store-bought produce and fewer shopping trips.

- **Non-freezer lots** also store `quantity` in the item's unit (grams, or pieces for items such as eggs). `total_g` is the quantity when the unit is grams, or `quantity * grams_per_piece` for piece items. Deduct and reserve in that same unit.
- **Freezer lots** are stored as packages, because they have to be thawed whole. Adding one records `total_g` and `package_count` (for example 10200 g of chicken breasts in 12 packages, average 850 g). On-hand is the remaining packages. Location is also how they see what is in the chest freezer; there is no other freezer logic.

**lot_packages** — one row per package in a freezer lot. `id`, `lot_id`, `weight_g` (the actual weight if recorded, otherwise the lot average, `total_g / package_count`). When a package weight is known, save it on that row (for example 852 g); the rest can stay on the average.

A new lot is added when groceries are brought in (including when a shopping-list row is checked off, with the total price paid and the total grams, plus package count if it is going in the freezer), and when Shane or Bella put processed cuts, canned jars, or other output back by hand (a freezer lot of cuts is entered as total grams plus package count, with an optional total price).

Expiry for a lot is `added_on + shelf_life_days` when the item has a shelf life; items with no `shelf_life_days` are not auto-flagged. A lot is **use soon** if that expiry is today or earlier, or within the next 3 days. An item is use soon if any of its lots are. A recipe is use soon if it uses any use-soon item. When stock is reserved or deducted, take from the use-soon / nearest-expiry lot first, then the oldest `added_on`. For a freezer lot, that means holding or removing a whole package from that lot.

A **stock count** is the final source of truth. For a non-freezer item, if the counted total is lower than the lot sum, deduct the difference from lots in that same use-first order (after reserved packages or amounts, or including them if the count cannot otherwise be met); if it is higher, add a lot dated today for the difference (location and source can be set; total price optional). For a freezer lot, the count is in packages: drop extra unreserved packages in use-first order, or add packages at the lot average. Do not make the count walk each lot or package by hand.

**recipes** — `id`, `name`, `cooked_yield_g` (required, typed; for example 1000 g curry, 500 g cooked rice, or 10000 g for a 10 L tomato-sauce canning day), optional `notes`. No servings field: a portion is a cooked weight you ask for, unless a freezer package sets the batch size instead. Sides are separate recipes, never baked into the main dish. A canning or processing day is just a recipe planned on a day, with meal type For Stock. The planner does not create output lots for jars, cuts, or leftovers; those are added by hand, and may be marked homestead.

**recipe_ingredients** — `id`, `recipe_id`, `item_id` (foreign key to `items`; deleted with the recipe), `quantity` (the as-made batch amount, in the item's unit: raw grams, or pieces). Scale factor is normally `requested_cooked_g / cooked_yield_g`. For piece items, grams for W/W% and kcal are `quantity * grams_per_piece` (3 eggs at 60 g is 180 g); the UI can still show the piece count. Portion kcal uses kcal per 100 g on those grams. Gram ingredients can also be shown as W/W% of the cooked yield (`quantity_g / cooked_yield_g`).

When a planned dish uses a freezer item, planning pulls whole packages (usually one). The package weight sets the batch size: scale the recipe so that ingredient equals the package (852 g known, or the 850 g average). If the recipe needs more than one package, pull enough whole packages and scale to their combined weight. Anything extra is leftovers, which are not tracked. Recipes themselves always stay in grams.

**plan_entries** — `id`, `date`, `recipe_id`, `quantity_g` (the cooked grams for that line; when a freezer package sets the batch, this is the scaled cooked yield), `meal_type` (`candy`, `dinner`, `breakfast`, `lunch`, or `for_stock`), `status` (`planned` or `deducted`). Optional `package_id` (or a small list) when the line has reserved freezer packages. A day is a flat list of these rows, with no fixed meal times. A main and a side are two lines (curry, rice). Show them sorted in this order: Candy, Dinner, Breakfast, Lunch, For Stock (baking and canning).

Planned meals **reserve** stock. Available stock is on-hand minus what other `planned` entries have reserved. Reservations for freezer items are the specific packages on the line; for non-freezer items they are the scaled grams or pieces, taken use-soon / oldest first at deduct time. A `planned` line can be changed or removed up to and including its day, which updates or releases the reservation. Once the day has passed (`date < today`), reserved stock is deducted automatically: non-freezer lots are reduced by the reserved amounts, freezer packages on the line are removed, and the line becomes `deducted`. Run that catch-up on server start and at the start of stock, plan, and shopping requests — no cron job. Deducted lines stay for history and are not edited. Leftovers are not tracked; only the raw (or hand-added) grocery stock.

**shopping_items** — `id`, `item_id` (null if a one-off manual line with just a name), `name` (copied for display), `quantity`, `unit`, `checked` (0 or 1), `source` (`manual` or `generated`), and a computed `estimated_cost` from the latest store lot's unit price per gram (or per package, if the shortfall is a freezer item). Generation walks `planned` entries in the current two weeks, scales their ingredients, subtracts available stock (on-hand minus reserved; freezer compared in whole packages and their gram weights), and also adds items whose available stock is below `min_stock`. Upsert the `generated` rows; leave checked and manual rows alone.

When a recipe is added to a day, "can make" means the scaled ingredients (or whole freezer packages) fit in stock that is still available; otherwise those shortfalls will add to the grocery list. The UI should show when a freezer package will set the batch.

## API

JSON only, all under `/api`. No auth. Computed fields belong in the JSON, not extra tables. Before answering stock, plan, or shopping requests (and on server start), deduct any `planned` entries whose date has passed.

- `GET/POST /api/items` — list (include on-hand, reserved, available, on-hand by location, freezer package counts, use_soon, latest and average store unit price per gram, and whether available stock is below min), create. Optional `?location=` to focus on one place (for example the freezer).
- `GET/PUT/DELETE /api/items/:id` — get one with lots and, for freezer lots, packages (and which packages are reserved); update catalog fields (name, unit, grams_per_piece, kcal per 100 g, min/max, shelf life); delete if unused.
- `POST /api/items/:id/lots` — add a lot. Record `total_price` (optional; omit for homestead), `total_g`, `added_on` (default today), `location`, and `source`. Non-freezer lots also take `quantity` in the item's unit. Freezer lots take `package_count` and create that many packages at the average weight (`total_g / package_count`). Unit prices are computed, not sent in.
- `PUT /api/items/:id/lots/:lotId/packages/:packageId` — record or correct a package's actual weight.
- `PUT/DELETE /api/items/:id/lots/:lotId` — correct a lot if needed.
- `PUT /api/items/:id/count` — body `{ quantity, location?, source? }`; adjusts lots as above. For freezer stock, `quantity` is a package count.
- `GET/POST /api/recipes` — list (include kcal per 100 g of cooked yield, and use_soon if any ingredient item is use soon), create (body includes `cooked_yield_g` and an `ingredients` array of `{ item_id, quantity }`).
- `GET/PUT/DELETE /api/recipes/:id` — get one with ingredients (piece lines include their gram equivalent); optional `?quantity_g=` returns the scaled ingredient list and portion kcal; optional `?package_id=` (or package weights) scales the recipe to that package.
- `GET /api/plan?from=YYYY-MM-DD&to=YYYY-MM-DD` — entries in range, each with recipe name, `quantity_g`, `meal_type`, `status`, portion kcal, `use_soon`, and `can_make` (plus the items that would go on the grocery list if not, and the freezer package that would set the batch). A day's lines come back already in meal-type order: Candy, Dinner, Breakfast, Lunch, For Stock.
- `POST /api/plan` — body `{ date, recipe_id, quantity_g, meal_type, package_id? }`; adds a `planned` line and reserves stock. If a freezer package is chosen (or suggested), `quantity_g` is the cooked yield scaled to that package.
- `PUT/DELETE /api/plan/:id` — allowed while the line is `planned` and `date >= today`: change the cooked grams, meal type, or package, or remove the line, and update the reservation. Reject edits to `deducted` lines or to dates that have already passed.
- `GET/POST /api/shopping` — list (include estimated cost per line and a list total, excluding homestead prices), add a manual item.
- `POST /api/shopping/generate` — rebuild generated rows from the plan versus available stock and min levels.
- `PUT /api/shopping/:id` — check off or edit quantity. Checking off, when the line has an `item_id`, should offer to add a lot (`total_price`, `total_g`, and `package_count` if freezer; location; source defaulting to store; date today).
- `DELETE /api/shopping/:id`

Keep the handlers in one or two files next to `server.ts`. Open the database once, and create tables with `CREATE TABLE IF NOT EXISTS` on startup. No migration framework.

## Screens and components

Reuse the three existing pages and the nav. Groceries holds both the item catalog / stock and the shopping list; no fourth page in v1.

- **Home (`/`)** — the existing two-week planner. Extend `planner-day` so a day is a flat list of dishes (name, meal type, cooked grams, kcal), sorted Candy, Dinner, Breakfast, Lunch, For Stock. Add a line by picking a recipe, a meal type, and a cooked quantity — or, when the dish uses a freezer item, a package (actual or average weight), which sets the batch size and is reserved. Show clearly whether it can be made from available stock or will add items to the grocery list, and mark use-soon recipes. A planned line can be edited or removed through the end of its day. After the day passes, it shows as deducted. A day kcal total, and a week kcal total on each week heading. On a phone, days stack vertically; on a wide screen, keep a week grid if it still fits.
- **Recipes (`/recipes`)** — list recipes with kcal per 100 g cooked, and a use-soon mark when relevant. Add or edit: name, cooked yield in grams, and ingredient rows chosen from the item list (quantity in g or pieces, with the gram equivalent shown for pieces). Live napkin totals for the batch and for a "if I want X g" or "if I thaw this package" preview.
- **Groceries (`/groceries`)** — two sections. Inventory: the item list, on-hand / reserved / available, a simple way to see what is in the freezer (lots as package counts and average or actual weights), min/max, use-soon, latest store unit price per gram; open an item to see and add lots (location, source, total price paid and total grams; freezer lots also take package count, and you can later record a package's actual weight), edit catalog fields including grams-per-piece, or enter a stock count (packages, when counting a freezer lot). Shopping: a check-off list with a cost estimate, manual add, and generate-from-plan (also covering items below min). Checking off can add a lot from the total price and amount bought.

Add new custom elements only where they earn their keep, in the same style as `PlannerDay` (no shadow DOM, so the existing stylesheet keeps working): for example `recipe-form`, `inventory-item`, `shopping-item`. Share fetch helpers in `common.ts`.

The first CSS work is a mobile-first pass: readable on an iPhone 11, thumb-sized nav and buttons, stacked days. Then the desktop week grid.

Also in the first slice: bind `0.0.0.0`, log `http://<lan-ip>:3000`, and gitignore `foodPlanner.db`.

## Build order

Each slice should be usable on its own. Sizes are rough, for one person who already knows this stack. This model is larger than the first draft (shared items, lots, W/W% recipes, freezer packages, reservations), so a single sitting is tight. Slices 1–2 get real data in; 3–4 make it a daily tool.

**Slice 1 — Items, lots, and LAN.** Create the tables. Bind `0.0.0.0:3000` and print the LAN URL. Gitignore the database. Item and lot APIs, plus the inventory section on Groceries: catalog fields (including grams-per-piece and kcal per 100 g), add a lot (location, source, total price paid and total grams; freezer lots also as package count, with optional actual package weights), computed unit prices, stock count, on-hand by location, min/max, use-soon. *Usable: they can build the grocery list and record what is in the house, including boxed Meatles in the chest freezer and homestead lots.* About 2 hours.

**Slice 2 — Recipes as batches.** Recipe API and the Recipes page: pick items, enter as-made grams or pieces (pieces shown with their gram equivalent), type cooked yield, see kcal per 100 g cooked and a scale-to-X-g or scale-to-package preview. *Usable: they can enter recipes, including a canning-day batch, and ask for a quantity.* About 1.5 hours.

**Slice 3 — Plan the week.** Plan API. Extend `planner-day` with a flat list of dishes, each with a meal type in the Candy → Dinner → Breakfast → Lunch → For Stock order, cooked grams (or a freezer package that sets the batch and is reserved), the available-stock vs grocery-list indicator, use-soon marks, and daily/weekly kcal. Planned lines can be changed or removed through the end of their day. Mobile-first so Bella can plan from her phone. *Usable: a two-week meal plan on the LAN, with stock reserved.* About 1.5 hours.

**Slice 4 — Shopping list and auto-deduct.** Generate the list from the plan versus available stock and min levels, with cost estimates from calculated store unit prices; check off (and add a lot from total price, grams, and package count if needed). When a plan day has passed, deduct reserved grams or whole packages automatically; they add any output lots by hand. *Usable: take the phone to the store, see an approximate cost, and keep the running total honest.* About 1 hour.

Tidy-ups that are not a slice: the unused `jsx: "react-jsx"` in `tsconfig.json`; whether to stop committing `dist/`; the slightly fragile `dist/` path rewrite in `server.ts`. Only touch these if they get in the way.
