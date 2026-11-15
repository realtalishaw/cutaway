/**
 * Thumbnail formats that are working on YouTube now, used to design whole thumbnails.
 *
 * Summarised in our own words from Richard (@Richard_YTS), "100 Thumbnail Formats to BLOW UP Your YouTube Channel
 * in 2026" (a thread on X). Only the ideas are used: no example thumbnails ship with Cutaway. Pure.
 */

export interface ThumbnailFormat {
  id: number;
  name: string;
  /** Which group it belongs to, see THUMBNAIL_FORMAT_PARTS. */
  part: number;
  /** What is in the picture and where. */
  look: string;
  /** Why viewers click. */
  why: string;
}

export const THUMBNAIL_FORMAT_PARTS: Record<number, string> = {
  "1": "Show the result (proof, money, outcomes)",
  "2": "Make them pick a side (comparisons, rankings)",
  "3": "Tell them where to look (arrows, maps, focus objects)",
  "4": "Borrow authority (conversations, founders, books)",
  "5": "Make it look like evidence (health, science)",
  "6": "The logo or interface is the hook (tech, AI tools)",
  "7": "Break the pattern (angles, edits, raw styles)",
  "8": "Borrow attention that already exists (news, film, history, food)"
};

export const THUMBNAIL_FORMATS: ThumbnailFormat[] = [
  {"id": 1, "name": "Dashboard Receipt", "part": 1, "look": "host's face beside a revenue or analytics dashboard with one huge number", "why": "a real number from a real dashboard is the strongest \"how did you do that?\" trigger."},
  {"id": 2, "name": "Credential Arrow", "part": 1, "look": "founder seated, a small arrow pointing to a \"$XM founder\" style label, and a short quote in lowercase across the bottom", "why": "curiosity about the quote, plus a credential that makes this the person worth hearing."},
  {"id": 3, "name": "Cash Wall", "part": 1, "look": "host behind or among stacks of cash", "why": "desire first, then \"how?\". A real person makes it feel reachable."},
  {"id": 4, "name": "Gig Receipt", "part": 1, "look": "host in a work vest or uniform, holding or beside an earnings card", "why": "answers \"is this side job actually worth it?\". The outfit says \"anyone can do this\"."},
  {"id": 5, "name": "Too-Good Ratio", "part": 1, "look": "host plus two stacked banners, for example money earned over hours per week", "why": "sounds too good to be true. Some click to get it, others to find the catch."},
  {"id": 6, "name": "Feet Up", "part": 1, "look": "host leaning back, feet on the desk, with an income number", "why": "sells the feeling of freedom. The number turns a daydream into \"how?\"."},
  {"id": 7, "name": "Over-the-Shoulder Proof", "part": 1, "look": "side or over-the-shoulder shot of the host at a screen showing the result", "why": "feels like peeking at something private. The result is shown, the method isn't."},
  {"id": 8, "name": "Night Mode Laptop", "part": 1, "look": "wide, dark scene, host lit by a laptop, a glowing per-day number", "why": "matches the late-night hustle, and the dark frame makes the number pop."},
  {"id": 9, "name": "The Jump", "part": 1, "look": "host in the middle with a \"before\" stat card on one side and an \"after\" card on the other", "why": "shows the transformation, with the host as the reason it happened."},
  {"id": 10, "name": "Two Graphs", "part": 1, "look": "host between a flat graph and a rising graph, with \"just copy me\" style text", "why": "the graphs are the proof, and the text promises an easy path."},
  {"id": 11, "name": "Low to Big Number", "part": 1, "look": "host centred, small start number on the left, big end number on the right", "why": "symmetrical and read in under a second. The bigger the jump, the bigger the pull."},
  {"id": 12, "name": "Red to Green", "part": 1, "look": "background shifting from red to green, before and after numbers, host in the middle", "why": "everyone reads red as bad and green as good, so the change is understood instantly."},
  {"id": 13, "name": "Boring Icon, Big Number", "part": 1, "look": "one ordinary object or icon on a clean background with a huge revenue figure", "why": "the mismatch. How does something this dull make that much?."},
  {"id": 14, "name": "The Economics Of…", "part": 1, "look": "a business, building or purchase drawn as a labelled breakdown", "why": "tied to the \"The Economics of…\" title style, which viewers recognise."},
  {"id": 15, "name": "One-Person Machine", "part": 1, "look": "\"1-person business\" header, host, and an AI agent flow diagram", "why": "the header is the dream, and the diagram is too detailed to read small, so people click to see it."},
  {"id": 16, "name": "Live Fix", "part": 1, "look": "two people working over a written plan, with before and after revenue numbers", "why": "an insider look at a real coaching session. The detail promises value."},
  {"id": 17, "name": "Copy This Plan", "part": 1, "look": "\"COPY THIS PLAN\" text, a dense plan sheet, and a big target number", "why": "low effort for a big outcome, and the sheet is unreadable at small size, so they click."},
  {"id": 18, "name": "Copy Me", "part": 1, "look": "bold \"COPY ME\" with the host pointing at the camera or a screen", "why": "promises a ready-made system and removes the fear of figuring it out alone."},
  {"id": 19, "name": "Whiteboard Lesson", "part": 1, "look": "host on the left, whiteboard with milestones (often money) on the right", "why": "\"lesson\" plus a plan to follow. Very strong right now when relevant."},
  {"id": 20, "name": "Cheap vs Expensive", "part": 2, "look": "split screen of a cheap and an expensive version of the same thing", "why": "everyone wants to know if the expensive one is worth it. Repeatable on any product."},
  {"id": 21, "name": "Curated Lineup", "part": 2, "look": "host beside or between a neat row of products", "why": "promises a shortlist from someone the viewer trusts."},
  {"id": 22, "name": "Spot Yours", "part": 2, "look": "a row of familiar products with labels or prices", "why": "the eye jumps to the one you own, and now you need to see how it ranks. Works with brands in business niches too."},
  {"id": 23, "name": "Wrong vs Right", "part": 2, "look": "the same pose or body twice, labelled red WRONG and green RIGHT", "why": "fear of doing it wrong. Huge in fitness and health."},
  {"id": 24, "name": "Pick One", "part": 2, "look": "two items (vials, bottles) held up side by side", "why": "understood in a second, and promises to tell you which is better."},
  {"id": 25, "name": "Game vs Reality", "part": 2, "look": "split image labelled \"game\" and \"real\", with a red arrow on one detail", "why": "fans love the real story behind what they play."},
  {"id": 26, "name": "The Iceberg", "part": 2, "look": "iceberg graphic with labelled tiers from known to obscure", "why": "a meme everyone can read, promising a rabbit hole."},
  {"id": 27, "name": "You Are Here", "part": 2, "look": "host beside a bell curve with a \"you are here\" marker", "why": "promises to move the viewer ahead of everyone else."},
  {"id": 28, "name": "Levels 1–7", "part": 2, "look": "rainbow columns labelled level 1 to 7", "why": "lays out the whole video at a glance, and the colours pop in any feed."},
  {"id": 29, "name": "Tier List", "part": 2, "look": "colour-coded S-to-F tiers down one side with the items being ranked", "why": "everyone has an opinion and clicks to agree or argue."},
  {"id": 30, "name": "Guess Which One", "part": 2, "look": "host plus a lineup of people and a challenge (\"Guess the millionaire\")", "why": "a game the viewer starts playing on sight."},
  {"id": 31, "name": "Name-Tag Lineup", "part": 2, "look": "a long row of faces, each labelled with a name or logo, some cut off at the edges", "why": "signals a complete, fact-heavy list. Viewers scan for names they know."},
  {"id": 32, "name": "CEO Columns", "part": 2, "look": "a lineup of famous people, each in front of a bright colour column", "why": "a twist on Levels. Colourful, and it hints at a shared secret."},
  {"id": 33, "name": "Torn Frame", "part": 2, "look": "barcode-style packaging torn open to reveal a well-known logo", "why": "signals that something has changed for that brand."},
  {"id": 34, "name": "Countdown Chart", "part": 2, "look": "host plus a chart labelled with years starting from this year", "why": "turns a vague topic into a dated prediction."},
  {"id": 35, "name": "Then vs Now", "part": 2, "look": "the same scene in two eras, each half labelled with a year or \"Today\"", "why": "spot the difference instantly, then wonder what happened between."},
  {"id": 36, "name": "Clock-Stamped Day", "part": 2, "look": "several panels, each with a time stamp", "why": "a whole day at a glance, and people compare it with their own."},
  {"id": 37, "name": "Day/Time Tracker", "part": 2, "look": "one moment from the creator's day with a big \"DAY 14\" or \"3AM\" stamp", "why": "day-in-the-life and challenge progress, proven in long and short form."},
  {"id": 38, "name": "Understated Arrow", "part": 3, "look": "a small lowercase label and an arrow at one small detail", "why": "tells the eye where to look, and \"why that?\" makes them click."},
  {"id": 39, "name": "Tiny Red Arrow", "part": 3, "look": "an old manuscript or scroll with strange drawings and one tiny red arrow", "why": "already mysterious. The arrow picks out one odd detail."},
  {"id": 40, "name": "Red Arrow Map", "part": 3, "look": "a map with one red arrow", "why": "shows where, and suggests movement or threat."},
  {"id": 41, "name": "Arrows In", "part": 3, "look": "labelled map with several arrows pushing into one country", "why": "reads as conflict instantly and rides existing news demand."},
  {"id": 42, "name": "Lit-Up Map + Stay Away", "part": 3, "look": "a map with one area lit up and an arrow to \"STAY AWAY\"", "why": "people who recognise the region feel called out without it being named."},
  {"id": 43, "name": "Spotlight Object", "part": 3, "look": "one object, dramatically lit, on black", "why": "nothing else to look at, so even an ordinary object looks important. Suits engineering and history."},
  {"id": 44, "name": "Cutaway + One Word", "part": 3, "look": "a cutaway or top-down render of a famous object plus one verdict word (\"Problems\", \"Slow\")", "why": "the unusual angle stands out, and the word is a verdict with no explanation."},
  {"id": 45, "name": "Suspicious Product", "part": 3, "look": "one everyday product filling the frame with a label like \"duped\"", "why": "suspicion about something people already trust."},
  {"id": 46, "name": "Aerial Investigation", "part": 3, "look": "aerial shot of a property, a warning label, host in a corner", "why": "looks like an investigation, and the label needs explaining."},
  {"id": 47, "name": "Sticker Cut-Out", "part": 3, "look": "host cut out with a thick white outline, several panels behind", "why": "the outline pops at small size, and the panels preview the topics."},
  {"id": 48, "name": "One in the Crowd", "part": 3, "look": "one person in colour (or highlighted) in a black-and-white lineup", "why": "you assume what they'll say is different too."},
  {"id": 49, "name": "Center Headline", "part": 4, "look": "two faces on the sides and a bold headline between them", "why": "the headline reads first, and recognisable faces pull second."},
  {"id": 50, "name": "Mid-Sentence Guest", "part": 4, "look": "guest frozen mid-gesture or mid-expression, with a headline in quotes", "why": "looks like the most intense moment, so people want the context."},
  {"id": 51, "name": "The Panel", "part": 4, "look": "several faces in a row with one dramatic caption along the bottom", "why": "more faces means more chances of recognition, and the caption frames the debate."},
  {"id": 52, "name": "Picture Between Them", "part": 4, "look": "host and guest on each side of a framed image of the topic", "why": "no reading needed, and a strange image raises a question."},
  {"id": 53, "name": "Name, Quote, Face", "part": 4, "look": "name and short quote on the left, a big famous face on the right", "why": "reads left to right, and people click to check the quote."},
  {"id": 54, "name": "Founder + Icon Product", "part": 4, "look": "founder beside an oversized version of their famous product", "why": "topic in a second, plus a rise-or-fall story."},
  {"id": 55, "name": "Book Towers", "part": 4, "look": "host framed by stacks of books", "why": "instant knowledge signal, \"the best ideas from all of these\"."},
  {"id": 56, "name": "Handful of Books", "part": 4, "look": "host holding several books in one hand", "why": "feels like a friend's recommendations."},
  {"id": 57, "name": "Steal This Framework", "part": 4, "look": "host holding an open book with \"steal this framework\" text", "why": "credibility plus something usable today."},
  {"id": 58, "name": "Focus Book", "part": 4, "look": "one book held right next to the host's face", "why": "all attention on the book, with the host as context."},
  {"id": 59, "name": "Notes I Wish I Had", "part": 4, "look": "host holding up a handwritten page with \"I wish I knew\" text", "why": "handwriting feels personal and hard-won."},
  {"id": 60, "name": "Unreadable Outline", "part": 4, "look": "host beside a written outline too small to read", "why": "signals a structured lesson. Not being able to read it is the point."},
  {"id": 61, "name": "The Free Seat", "part": 4, "look": "host on stage before an audience, with bold text on a big screen", "why": "\"people pay for this\", and you get it free."},
  {"id": 62, "name": "Lab Results", "part": 5, "look": "host revealing a real lab report or scan result", "why": "data over opinion, a personal experiment."},
  {"id": 63, "name": "Blood Tube", "part": 5, "look": "a blood tube or familiar medical tool, often with a clinician, plus a warning", "why": "personal, plus professional authority."},
  {"id": 64, "name": "Vial Wall", "part": 5, "look": "host in front of a whole wall of vials", "why": "looks comprehensive, and viewers scan for names they know."},
  {"id": 65, "name": "Brain Scan", "part": 5, "look": "host holding a colourful brain scan", "why": "reads as evidence for the claim."},
  {"id": 66, "name": "The X-Ray", "part": 5, "look": "host plus an X-ray on plain white", "why": "clinical, modern, clear topic."},
  {"id": 67, "name": "The Dose", "part": 5, "look": "host with a pill on their tongue and a dosage number", "why": "novel. The number forces a read of the title."},
  {"id": 68, "name": "The Drink", "part": 5, "look": "host drinking a brightly coloured drink", "why": "makes the outcome feel as easy as a cup of tea."},
  {"id": 69, "name": "Offered Bowl", "part": 5, "look": "host holding a bowl of food out to the camera", "why": "the creator is handing you the solution."},
  {"id": 70, "name": "One Move, Big Claim", "part": 5, "look": "host mid-exercise with bold text (\"kills sugar\", \"STOP DOING THIS\")", "why": "an everyday move tied to a surprising claim."},
  {"id": 71, "name": "Mid-Rep", "part": 5, "look": "host caught mid-exercise", "why": "shows the exact move and real effort. The physique is the proof."},
  {"id": 72, "name": "Space Is the Hero", "part": 5, "look": "a striking space or science image, host at the edge, neon caption", "why": "the visual pulls the eye, and the caption asks the question."},
  {"id": 73, "name": "Glowing Icon", "part": 6, "look": "one tool's app icon, huge and glowing, often with a short label like \"New Claude!\"", "why": "instant recognition and an attention-grabbing glow."},
  {"id": 74, "name": "Tool + Tool = Result", "part": 6, "look": "two app icons joined by a plus sign, with the host", "why": "a simple equation, these two together beat either alone."},
  {"id": 75, "name": "The Combo", "part": 6, "look": "two app icons side by side with one word like \"INSANE\" or \"basically cheating\"", "why": "shows the topic, and the word raises the stakes."},
  {"id": 76, "name": "Converging Graph", "part": 6, "look": "host beside two converging lines with app icons on them", "why": "something is changing, and the icons make it the viewer's problem."},
  {"id": 77, "name": "Logo Grid", "part": 6, "look": "host centred in a grid of app logos", "why": "shows exactly which tools are covered, a complete roundup."},
  {"id": 78, "name": "Icon Orbit", "part": 6, "look": "host centred with app icons orbiting around them", "why": "familiar logos plus a guided tour."},
  {"id": 79, "name": "It's Over", "part": 6, "look": "\"IT'S OVER\" text, one big winning icon, smaller competitor icons", "why": "a shake-up with a winner, so users of the losers click."},
  {"id": 80, "name": "Broken Icon", "part": 6, "look": "a famous app icon cracked or \"dead\"", "why": "implies something big broke or changed."},
  {"id": 81, "name": "The Loom", "part": 6, "look": "a screen recording of a document with a webcam bubble in the corner", "why": "deliberately low-effort, so it reads as a real walkthrough, not clickbait."},
  {"id": 82, "name": "Icon + Reaction", "part": 6, "look": "a game or app icon with the host reacting beside it", "why": "icon recognised instantly, and the face promises a fun reaction."},
  {"id": 83, "name": "Top Down, Sitting in It", "part": 7, "look": "overhead shot of the host sitting on the floor among the subject", "why": "the angle stands out, and \"what is going on?\"."},
  {"id": 84, "name": "Top Down, Standing", "part": 7, "look": "high angle looking down at the host standing", "why": "dramatic, full body. Suits fitness and transformation."},
  {"id": 85, "name": "First-Person POV", "part": 7, "look": "a POV shot of the creator's hands or routine", "why": "puts the viewer in the seat, and has no face, so it stands out."},
  {"id": 86, "name": "Lying Down", "part": 7, "look": "host lying down, with relatable text", "why": "candid, and breaks a feed of upright heads."},
  {"id": 87, "name": "Car Rant", "part": 7, "look": "selfie from the driver's seat, with bold text", "why": "raw and unscripted, like a friend venting."},
  {"id": 88, "name": "Selfie Vlog", "part": 7, "look": "arm's-length handheld selfie, mid-sentence", "why": "feels like a message to you, not a production."},
  {"id": 89, "name": "Cardboard Sign", "part": 7, "look": "host holding a short handwritten cardboard sign", "why": "a confession or protest, and a few words leave the full story untold."},
  {"id": 90, "name": "Look at This", "part": 7, "look": "host pushing a phone toward the camera with \"DON'T DO THIS\"", "why": "urgent, like being grabbed to see something."},
  {"id": 91, "name": "Six Arms", "part": 7, "look": "host edited with several arms, each doing a different task", "why": "weird, and shows \"doing everything alone\"."},
  {"id": 92, "name": "The Melt", "part": 7, "look": "two objects melting or warping into each other", "why": "surreal, an unexpected connection."},
  {"id": 93, "name": "Open Head", "part": 7, "look": "the top of a head opened up, with icons pouring out", "why": "visualises the mind. Suits psychology and learning, and looks high-effort."},
  {"id": 94, "name": "Caught Moment", "part": 7, "look": "host caught mid-action with one line of lowercase text", "why": "a candid frame from the vlog, life shown rather than posed."},
  {"id": 95, "name": "Mood Board", "part": 7, "look": "several panels arranged like a Pinterest grid", "why": "sets the vibe and signals a packed video."},
  {"id": 96, "name": "Floating List", "part": 7, "look": "host centred with objects floating around them", "why": "each object previews an item. Light and playful."},
  {"id": 97, "name": "Desk Shot", "part": 7, "look": "host at a desk facing the camera, with a short label", "why": "sitting across the table from them feels honest and personal."},
  {"id": 98, "name": "Breaking News", "part": 8, "look": "a news-style lower-third bar with an alarm headline", "why": "read instantly as urgent."},
  {"id": 99, "name": "One Word on a Film Still", "part": 8, "look": "a recognisable movie frame with one single word", "why": "borrows the film's emotion, and the word is a thesis."},
  {"id": 100, "name": "Storefront Feast", "part": 8, "look": "a famous restaurant storefront behind the host, with a huge spread of its food in front", "why": "instant recognition, opinions, appetite."},
];

export function thumbnailFormat(id: number): ThumbnailFormat | null {
  return THUMBNAIL_FORMATS.find((f) => f.id === id) ?? null;
}

/** The catalogue as a prompt block: grouped, one line per format. */
export function thumbnailFormatsBlock(): string {
  return Object.entries(THUMBNAIL_FORMAT_PARTS)
    .map(([p, name]) => [`${name}:`, ...THUMBNAIL_FORMATS.filter((f) => f.part === Number(p)).map((f) => `  #${f.id} ${f.name}: ${f.look}. ${f.why}`)].join('\n'))
    .join('\n');
}
