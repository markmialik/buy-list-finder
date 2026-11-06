# Buy List Finder

A personal buy list. Each item has one-tap links that search eBay and Facebook Marketplace, with that item's filters already set (price, condition, category and distance).

Live site: https://markmialik.github.io/buy-list-finder/ (sign-in required)

## What it does

Each item can open one of these:

- **eBay, Buy It Now:** new fixed-price listings (including "or Best Offer"), newest first.
- **eBay, auctions:** auctions ending soonest.
- **Facebook Marketplace:** newest listings first.

Each link carries the item's details: search words, price range, condition, category and distance. A word with a minus sign in front is left out of the search. For example, `seiko quartz -solar` searches for seiko quartz but not "solar". eBay honours that. Facebook cannot exclude words, so there the minus words are simply dropped.

Distance only applies to Facebook: it uses the item's distance, or a default radius if the item has none. eBay always searches nationwide, because everything there ships.

## Arrange and Quick check

Your list stays in exactly the order you choose. Each row starts with its number in the whole list (1, 2, 3...). New items go to the end.

**Arrange.** Tap **Arrange** in the top bar to change the order. Each row then shows a big number and three buttons: **▲** and **▼** move the item one place, **Top** moves it to the front. Tap the number to type the place you want instead. Filters and search still work while you arrange. A move counts places among the items you can see, so hidden items never jump over each other. They stay where they were. Your change is saved a moment after your last tap, and again when you tap **Done** or leave the page. If a save fails you get a message and the list goes back to what is saved.

**Quick check.** Tap **▶ Check** to go through the items shown, one by one, in list order, starting at the top. Pick **eBay newest** or **Facebook**. Only items that can be searched on that site are included, and the button shows how many. The first search opens straight away. When you come back to the page, a panel at the bottom shows the next item, counts down about 2 seconds and opens it for you. You can tap **Skip**, **Open now** or **Stop**. If you leave during the countdown, it waits and shows **Continue**. Your place is remembered on the device for 12 hours. On a computer there is no countdown, because the browser would block the new tabs. Tap **Open** for each item instead.

On iPhone the Facebook app drops the filters, so for Facebook the panel repeats what to set by hand. To get your best items first, arrange the list or use the High priority chip before you start.

## How it works

- The site is a plain web page (HTML, CSS and JavaScript). GitHub Pages hosts it for free. There is no server of our own.
- Your list is stored in a private Supabase database.
- Sign-in is required. Only accounts listed in the database's `app_users` table can read or change anything. The database's row-level security rules enforce this, not the web page.
- The public key in `js/config.js` is safe to publish. On its own it cannot read or change anything, because reading needs a signed-in account.
- The site never fetches or scrapes eBay or Facebook. It only builds links, which your phone then opens.

## Files

- `index.html`: the main page with your buy list.
- `styles.css`: the page's look (colours, layout, text size).
- `js/config.js`: the database address and public key. Safe to publish (see above).
- `js/links.js`: builds the eBay and Facebook links. The only file that knows their URL codes.
- `js/db.js`: reads and saves items in the database, including the list order.
- `js/app.js`: the page's behaviour, showing items and handling buttons.
- `supabase/migrations/`: the database setup (tables and security rules), applied in order.
- `tests/`: automatic tests for `js/links.js`. `tests/run.sh` runs them.
- `manifest.webmanifest`, `icon.png`, `icon-512.png`: the home-screen icon and app settings.
- `data/`: personal import files. `.gitignore` keeps it out of GitHub.

## If eBay or Facebook change their links

1. Open `js/links.js`.
2. Edit the `CODES` table at the top. It holds every eBay and Facebook code: parameter names, condition numbers, category numbers, sort options and Facebook radius steps.
3. Run the tests (see below).
4. Tap a few item buttons on your iPhone. The tests only check how links are built. They can't tell whether eBay or Facebook still accept them.

What the iPhone test showed (Nov 2026): the eBay app keeps every filter from the link. The Facebook app searches the words but drops the filters, which is why the page shows a "set these in the app" hint under the Facebook button.

## Run the tests

In Terminal, from the project folder:

    ./tests/run.sh

If you see "permission denied", run `sh tests/run.sh` instead.

It needs a Mac and nothing else installed. Each test prints PASS or FAIL, and the script ends with a summary. If any test fails, the script exits with an error.

## Updating the site

1. Commit your changes and push them to the `main` branch on GitHub.
2. GitHub Pages republishes the site in about a minute.

This repository is public. Never put personal details in it: email addresses, ZIP codes, passwords or your item list. Items live in the database, not in the files.

## On iPhone

1. Open the site in Safari.
2. Tap Share, then Add to Home Screen.

The app is set to "browser" display mode on purpose. Tapped eBay and Facebook links then behave like normal Safari links, so they can open the eBay and Facebook apps.

## Later

An agents phase is planned. AI agents will research prices and alert you to new deals. They will reach the site through a separate gateway, with its own key for each agent. This is not built yet.
