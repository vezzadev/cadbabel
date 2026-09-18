// Hallmark · genre: editorial · macrostructure: Split Studio · theme: Grid · enrichment: none

const STRIPE_JS = "https://js.stripe.com/v3/";
const RESERVE_LABEL = "Reserve a slot";
const CARD_LABEL = "Put the card on file";
const CARD_RETRY_LABEL = "Load the card field again";
const FALLBACK_EMAIL = "pedro@vezza.com.br";
// Same URL as tokens.css's @font-face and index.html's preload, handed to the
// Stripe iframe so the card field can resolve the family the page names.
const ARCHIVO_WOFF2 = "/fonts/archivo-latin-var.woff2";

const form = document.getElementById("reserve-form");
const submit = document.getElementById("reserve-submit");
const result = document.getElementById("reserve-result");
const cardStep = document.getElementById("card-step");
const cardMount = document.getElementById("card-mount");
const cardSubmit = document.getElementById("card-submit");
const cardResult = document.getElementById("card-result");
const plate = document.getElementById("disclosure");

const directionRadios = form.querySelectorAll('input[name="direction"]');
const purpose = document.getElementById("purpose");
const neededBy = document.getElementById("needed_by");
const email = document.getElementById("email");
const ack = document.getElementById("disclosure_ack");
const directionHelp = document.getElementById("direction-help");
const purposeHelp = document.getElementById("purpose-help");
const emailHelp = document.getElementById("email-help");
const ackHelp = document.getElementById("ack-help");

// The timestamp we report is the moment the disclosure actually entered the
// viewport, not page load. If IntersectionObserver never fires we have not
// observed it being read, so the field stays null and submission is blocked —
// but the block always carries a way out, because the two shortest routes to
// this form are links that skip the disclosure entirely.
let disclosureShownAt = null;

// `direction` is the one of record — what the API says the row carries, which
// on a recovered row is not what was just submitted.
const reservation = { id: null, direction: null, clientSecret: null, publishableKey: null };

function say(node, state, message) {
  node.dataset.state = state;
  node.textContent = message;
}

function busy(button, isBusy, idleLabel) {
  button.disabled = isBusy;
  button.dataset.state = isBusy ? "loading" : "idle";
  button.textContent = isBusy ? "Working…" : idleLabel;
}

// Resolved per call, not once at load: a visitor can flip the OS setting while
// the page is open, and the honest answer is whatever it says at scroll time.
function reveal(node, block) {
  const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  node.scrollIntoView({ behavior, block });
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `request failed (${response.status})`);
  return payload;
}

function recordEvent(kind, direction) {
  // Fire-and-forget: a counter must never block or break the page.
  postJson("/api/event", { kind, direction }).catch(() => {});
}

if (plate) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      disclosureShownAt = disclosureShownAt ?? new Date().toISOString();
      observer.disconnect();
    }
  });
  observer.observe(plate);
}

recordEvent("page_view", null);

// ─── doors ───

/** Repaints both doors from a direction value, wherever that value came from. */
function paintDoors(direction) {
  for (const door of document.querySelectorAll(".door")) {
    const picked = door.dataset.direction === direction;
    door.dataset.chosen = picked ? "yes" : "no";
    door.setAttribute("aria-pressed", picked ? "true" : "false");
  }
}

for (const door of document.querySelectorAll(".door")) {
  door.addEventListener("click", () => {
    // Once the row is filed, the direction on it is the one we will translate.
    // A door that still repainted the form would show the visitor a choice we
    // are not honouring, and would count a second door_select for one visit.
    // The doors are disabled at that point, so this only runs for a click that
    // raced the freeze. It says which direction is filed rather than assuming
    // the visitor was trying to change it, and it brings them to the form,
    // because #direction-help sits several screens away from the doors.
    if (reservation.id) {
      const filed = door.dataset.direction === reservation.direction;
      say(
        directionHelp,
        "ok",
        filed
          ? "Your slot is already filed for this direction."
          : `Your slot is filed for the direction above. Email ${FALLBACK_EMAIL} to change it.`,
      );
      reveal(document.getElementById("reserve"), "start");
      return;
    }

    const direction = door.dataset.direction;

    paintDoors(direction);

    const radio = radioFor(direction);
    if (radio) radio.checked = true;
    for (const each of directionRadios) each.setAttribute("aria-invalid", "false");
    // #direction-help is aria-live, so the change we made on the visitor's
    // behalf is announced rather than silently applied.
    say(directionHelp, "ok", "We copied this from the direction you picked above. Change it here if you like.");

    recordEvent("door_select", direction);

    reveal(document.getElementById("reserve"), "start");
    purpose.focus({ preventScroll: true });
  });
}

// ─── reservation ───

function clearProblems() {
  for (const helper of form.querySelectorAll(".helper")) {
    if (helper.dataset.state === "error") say(helper, "idle", "");
  }
  for (const control of [...directionRadios, purpose, email, ack]) {
    control.setAttribute("aria-invalid", "false");
  }
}

// One entry per failing control, so every error can be attached to the control
// itself (aria-invalid) and to the helper the control points at.
function findProblems() {
  const problems = [];
  const direction = form.querySelector('input[name="direction"]:checked');

  if (!direction) {
    for (const radio of directionRadios) problems.push([radio, directionHelp, "Pick a direction first."]);
  }
  if (!purpose.value) problems.push([purpose, purposeHelp, "Tell us what the part is for."]);
  if (!email.value.trim()) problems.push([email, emailHelp, "We need an email to reply to."]);
  if (!ack.checked) problems.push([ack, ackHelp, "Confirm you have read the disclosure."]);

  return problems;
}

function readBody() {
  const direction = form.querySelector('input[name="direction"]:checked');
  return {
    email: email.value.trim(),
    direction: direction.value,
    purpose: purpose.value,
    needed_by: neededBy.value || null,
    disclosure_ack: ack.checked,
    disclosure_shown_at: disclosureShownAt,
  };
}

/** The radio carrying a direction value, or undefined if the form has no such door. */
function radioFor(direction) {
  return [...directionRadios].find(radio => radio.value === direction);
}

/**
 * The wording the page uses for a direction. `labels` rather than
 * `nextElementSibling`: the text is a span inside the wrapping label today, and
 * that arrangement is not this file's to assume.
 */
function directionLabel(direction) {
  return radioFor(direction)?.labels[0]?.textContent.trim() ?? direction;
}

/** The visible label of a `<select>` option, or the raw value if none matches. */
function optionLabel(select, value) {
  return [...select.options].find(option => option.value === value)?.textContent.trim() ?? value;
}

/**
 * Sets the form and the doors back to the answers the API says the row carries,
 * and reports what that changed — as two separate facts, because they have
 * different causes and the visitor is owed both:
 *
 * - `overridden`: answers the row holds that differ from the ones POSTed. Only
 *   a recovered row does this, and it keeps what it was filed with.
 * - `reverted`: answers the visitor changed after submitting, while the request
 *   was in flight and the fields were still live. The row was already being
 *   written, so those edits were never sent anywhere.
 *
 * Diffing one against the other would confuse the two: a mid-flight edit would
 * read as "this email already had a reservation", which is a false statement
 * about the visitor's own history.
 */
function applyAnswersOfRecord(payload, submitted) {
  const live = readBody();
  const overridden = [];
  const reverted = [];
  // [body key, value of record, the value spelled out, the field's own name].
  // `?? ""` throughout because an empty date reads as null in the body and ""
  // in the input.
  const fields = [
    ["direction", payload.direction, `direction ${directionLabel(payload.direction)}`, "the direction"],
    ["purpose", payload.purpose, `purpose "${optionLabel(purpose, payload.purpose)}"`, "the purpose"],
    [
      "needed_by",
      payload.needed_by ?? "",
      payload.needed_by ? `needed by ${payload.needed_by}` : "no date",
      "the date",
    ],
  ];

  for (const [key, filed, value, label] of fields) {
    const sent = submitted[key] ?? "";
    const shown = live[key] ?? "";

    if (filed !== sent) overridden.push(value);
    // Two conditions, both required: the visitor edited the field after
    // submitting (what is shown differs from what was sent), and that edit is
    // about to disappear (the row says something else). An edit that happens to
    // agree with the row lost nothing, so there is nothing to report. The field
    // is named rather than the value, because the value about to replace theirs
    // is the one the form will show them.
    if (shown !== sent && filed !== shown) reverted.push(label);
  }

  const filedDirection = radioFor(payload.direction);
  if (filedDirection) filedDirection.checked = true;
  paintDoors(payload.direction);
  purpose.value = payload.purpose;
  neededBy.value = payload.needed_by ?? "";

  return { overridden, reverted };
}

// The gate stays: without an observed disclosure there is no audit trail and the
// API refuses the row. What changes is that the block is escapable — the plate
// comes to the visitor, and the message is a link back to it.
function blockOnDisclosure() {
  const link = document.createElement("a");
  link.href = "#disclosure";
  link.textContent = "Read the disclosure";

  result.dataset.state = "error";
  result.replaceChildren(
    document.createTextNode("You reached this form without passing the disclosure, and we record that you saw it before taking a reservation. "),
    link,
    document.createTextNode(" — it is right above — then reserve."),
  );

  reveal(plate, "start");
  link.focus({ preventScroll: true });
}

// Three states, and the difference matters. Once /api/reserve answers, the row
// is filed and the fields describe history: they are frozen for the rest of the
// visit, whatever happens to Stripe. Only the button moves after that.
//
// The doors freeze with them. They are the same control as the radios, so a
// door that still looked live — pointer cursor, hover paint — while silently
// refusing the click would be the affordance lying; `.door:disabled` is the
// state the design already carries for exactly this.
function freezeFields() {
  for (const field of form.querySelectorAll("input, select")) field.disabled = true;
  for (const door of document.querySelectorAll(".door")) door.disabled = true;
  // #direction-help is aria-live and, up to this point, invites editing ("change
  // it here if you like"). The radios it describes are now disabled, so leaving
  // that standing would be an affordance the page no longer offers.
  if (reservation.direction) {
    say(directionHelp, "ok", `Filed: ${directionLabel(reservation.direction)}. This is fixed for the rest of the visit.`);
  }
}

function lockForm() {
  freezeFields();
  submit.hidden = true;
}

function offerRetry(label) {
  submit.hidden = false;
  busy(submit, false, label);
}

async function loadStripe() {
  if (window.Stripe) return;
  await new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = STRIPE_JS;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error("could not load Stripe"));
    document.head.append(tag);
  });
}

// Stripe's appearance API takes HEX, rgb() or hsl() and rejects anything else,
// including the oklch() our tokens are written in — silently, with a console
// warning, leaving the iframe in Stripe's own grey. Reading `fillStyle` back is
// not the conversion: Chrome serialises an oklch() assignment as oklch(). So
// the colour is rasterised and the pixel read, which is sRGB by definition.
//
// The two literals are the parse guard, not design values: they are assigned to
// a detached canvas that is never painted on screen, and a value the browser
// cannot read leaves each in place, so they disagree and null is returned
// instead of a near-black sentinel being shipped to Stripe as a colour.
const PARSE_SENTINELS = ["#010203", "#040506"];

function srgbOf(value) {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  const parsed = PARSE_SENTINELS.map(sentinel => {
    context.fillStyle = sentinel;
    context.fillStyle = value;
    return context.fillStyle;
  });
  if (parsed[0] !== parsed[1]) return null;

  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;

  // Alpha is not a pass/fail flag: a translucent token rasterised over nothing
  // and reported as opaque would hand Stripe a colour the page never paints.
  // Anything but fully opaque degrades to Stripe's own defaults.
  return alpha === 255 ? `rgb(${red}, ${green}, ${blue})` : null;
}

/** Relative luminance per WCAG 2, from an `rgb(r, g, b)` string. */
function luminanceOf(rgb) {
  const [red, green, blue] = rgb.match(/\d+/g).map(part => {
    const channel = Number(part) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastOf(one, other) {
  const [lighter, darker] = [luminanceOf(one), luminanceOf(other)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The px value of a length token, measured rather than parsed: the token is
 * authored in rem, so reading the custom property gives "0.25rem" and hard
 * coding "4px" desyncs from the page at any root font size but 16px.
 */
function pxOf(token) {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;width:var(${token})`;
  document.body.append(probe);
  const width = getComputedStyle(probe).width;
  probe.remove();

  return /^[\d.]+px$/.test(width) ? width : null;
}

/**
 * Only the keys Stripe could parse, so a failure loses one variable, not all.
 *
 * The pair is checked, not just each colour: a browser that blocks canvas
 * readback answers with a uniform bitmap rather than failing, both reads come
 * back the same, and Stripe would render the card number in paper-on-paper.
 * An illegible pair is worse than no override, so it degrades to Stripe's
 * defaults. 4.5 is the WCAG AA body-text ratio; our own tokens sit near 19.
 */
function appearanceVariables(shell) {
  const variables = { fontFamily: shell.fontFamily, borderRadius: "0px" };
  const unit = pxOf("--s-1");
  if (unit) variables.spacingUnit = unit;

  const background = srgbOf(shell.backgroundColor);
  const text = srgbOf(shell.color);
  if (!background || !text || contrastOf(background, text) < 4.5) return variables;

  variables.colorBackground = background;
  variables.colorText = text;

  return variables;
}

/**
 * The one custom face, in Stripe's shape, when the origin can serve it to them.
 *
 * Stripe wants a bare `url(…)`: a `format(…)` clause makes it ignore the face.
 * The file is fetched by js.stripe.com rather than by us, which is why
 * public/_headers has to allow the cross-origin read — without it the face
 * reports `status: "error"` and the field falls back to Helvetica.
 *
 * Stripe.js then logs "Unrecognized font property: type" once per mount. That
 * is Stripe's own field, not ours: bisected on the PPE worker, the warning
 * appears for a minimal `{ family, src }` and never for `fonts: []`, while the
 * face still reaches `status: "loaded"`. Nothing to fix on this side.
 */
function archivoForStripe() {
  const source = new URL(ARCHIVO_WOFF2, location.href).href;
  if (!source.startsWith("https:")) return [];

  return [{ family: "Archivo", src: `url(${source})`, weight: "400" }];
}

async function mountCard(note = "") {
  await loadStripe();

  const stripe = window.Stripe(reservation.publishableKey);
  // Read the surface out of the cascade at mount time so the Stripe iframe
  // renders in the page's own tokens. No colour or font literal lives here:
  // --paper is not pure white, and --ink is not the Stripe default grey.
  const shell = getComputedStyle(document.body);
  const elements = stripe.elements({
    clientSecret: reservation.clientSecret,
    appearance: { theme: "flat", variables: appearanceVariables(shell) },
    // The iframe is a separate document, so tokens.css's @font-face does not
    // reach it and naming the family alone would leave the field in Helvetica
    // beside a page in Archivo. Same file the page preloads, so it is cached.
    //
    // Stripe refuses a font URL that is not https, which the local dev origin
    // is, so it is offered only when it can be honoured. Measured, not assumed:
    // over http Stripe logs "Invalid src value in font configuration" and the
    // field falls back — an empty list keeps that noise out of dev consoles.
    fonts: archivoForStripe(),
  });
  const payment = elements.create("payment", { fields: { billingDetails: { email: "never" } } });

  // A well-formed but unusable clientSecret — expired, or minted by a different
  // account — mounts without throwing and reports itself here instead. Without
  // this the visitor is left with an inert iframe under a status line claiming
  // one step is left, and no retry, because lockForm() has hidden the button.
  payment.on("loaderror", event => {
    cardLoadFailed(note, event.error?.message ?? "Stripe could not load the card field");
  });
  payment.mount(cardMount);

  cardStep.hidden = false;
  say(cardResult, "idle", "");

  // Assigned, not added: a retried mount must not stack a second handler.
  cardSubmit.onclick = async () => {
    busy(cardSubmit, true, CARD_LABEL);
    say(cardResult, "idle", "");

    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { payment_method_data: { billing_details: { email: email.value.trim() } } },
      redirect: "if_required",
    });

    if (error) {
      busy(cardSubmit, false, CARD_LABEL);
      say(cardResult, "error", error.message || "The card was not accepted.");
      return;
    }

    try {
      await postJson("/api/reserve/confirm", {
        reservation_id: reservation.id,
        setup_intent_id: setupIntent.id,
      });
    } catch (failure) {
      busy(cardSubmit, false, CARD_LABEL);
      say(cardResult, "error", failure.message);
      return;
    }

    say(cardResult, "ok", "Card on file, and we charged it nothing. You get a reply within a day that repeats the disclosure.");
    // Terminal state: the work is done, so the button stops advertising itself
    // as busy and stops accepting a second confirmation.
    cardSubmit.dataset.state = "ok";
    cardSubmit.disabled = true;
    cardSubmit.textContent = "Done";
  };
}

/**
 * One exit for every way the card field can fail to become usable: a thrown
 * mount, or a `loaderror` that arrives after the mount resolved. The slot is
 * filed either way, so the copy says so, the retry button comes back, and the
 * unusable field is taken off the page instead of sitting there inert.
 */
function cardLoadFailed(note, reason) {
  cardStep.hidden = true;
  cardSubmit.disabled = true;
  say(cardResult, "idle", "");
  offerRetry(CARD_RETRY_LABEL);
  say(
    result,
    "error",
    `${note}Slot recorded — that part is done and it stands. The card field did not load (${reason}), so no card is on file. Press the button to try it again, or email ${FALLBACK_EMAIL} and we will take the card another way.`,
  );
  submit.focus({ preventScroll: true });
}

// The row is written before this runs, so the fields are already history and
// stay frozen. A Stripe failure must still leave a way forward: the button
// comes back as a retry, and the copy states the slot stands and gives the
// email fallback. `note` carries anything the reservation step needs to keep
// saying, because #reserve-result is a single region.
//
// Focus is placed explicitly on both exits. freezeFields() disables whichever
// control the visitor submitted from — pressing Enter in #email is the common
// case — and a disabled control drops focus to <body>, which restarts Tab at
// the top of the document. The copy tells them to press a button, so focus goes
// to the button they are told to press.
async function openCardStep(note = "") {
  freezeFields();
  busy(submit, true, CARD_RETRY_LABEL);
  say(result, "ok", `${note}Slot recorded. One step left: put a card on file. We charge it nothing.`);

  try {
    await mountCard(note);
  } catch (failure) {
    cardLoadFailed(note, failure.message);
    return;
  }

  lockForm();
  cardSubmit.focus({ preventScroll: true });
}

form.addEventListener("submit", async event => {
  event.preventDefault();

  // The reservation already exists; the only thing left to retry is the card.
  if (reservation.id) {
    await openCardStep();
    return;
  }

  clearProblems();

  const problems = findProblems();
  if (problems.length > 0) {
    for (const [control, helper, message] of problems) {
      say(helper, "error", message);
      control.setAttribute("aria-invalid", "true");
    }
    say(result, "error", "Fix the fields above.");
    reveal(problems[0][0], "center");
    problems[0][0].focus({ preventScroll: true });
    return;
  }

  if (!disclosureShownAt) {
    blockOnDisclosure();
    return;
  }

  busy(submit, true, RESERVE_LABEL);
  say(result, "idle", "");

  const submitted = readBody();
  let payload = null;
  try {
    payload = await postJson("/api/reserve", submitted);
  } catch (failure) {
    busy(submit, false, RESERVE_LABEL);
    say(result, "error", failure.message);
    return;
  }

  reservation.id = payload.reservation_id;
  reservation.direction = payload.direction;
  reservation.clientSecret = payload.client_secret;
  reservation.publishableKey = payload.publishable_key;

  // Everything past this point runs with a reservation already on file, so a
  // throw here must not leave the visitor staring at a disabled "Working…"
  // button with no message: the row exists, and the page has to say so.
  try {
    await continueAfterFiling(payload, submitted);
  } catch (failure) {
    cardLoadFailed("", failure.message);
  }
});

async function continueAfterFiling(payload, submitted) {
  // The API answers with the values of record, and says whether the row was
  // created now or recovered from an earlier reservation for this email. A
  // recovered row keeps the answers it was filed with, because an email address
  // is not proof of who filed it, so the form is set back to the row.
  // `reservation_state` is used rather than a diff: a recovered row may hold
  // exactly the submitted answers, and then the honest message is still that
  // nothing new was recorded.
  const { overridden, reverted } = applyAnswersOfRecord(payload, submitted);
  // Said as part of the next message rather than now: #reserve-result is one
  // region, and the card step writes to it immediately after this.
  const sentences = [];

  if (payload.reservation_state === "recovered") {
    sentences.push(
      `This email already had a reservation, and it still stands.`,
      overridden.length > 0
        ? `We kept what it was filed with, so these are not what you just entered: ${overridden.join(", ")}.`
        : `What you entered matches it, so nothing changed.`,
      `Email ${FALLBACK_EMAIL} to change it.`,
    );
  }
  // A field the visitor changed after pressing the button: the row was already
  // being written, so the edit went nowhere. Saying nothing would leave the form
  // silently snapping back to values they had just replaced.
  if (reverted.length > 0) {
    sentences.push(
      `You changed ${reverted.join(" and ")} after the reservation was sent, so that change went nowhere — the form now shows what we actually filed.`,
    );
  }

  const note = sentences.length > 0 ? `${sentences.join(" ")} ` : "";

  if (payload.card_step !== "stripe") {
    lockForm();
    say(result, "ok", `${note}Slot recorded. No card is needed: card capture is not wired up yet, so there is nothing more to do.`);
    return;
  }

  await openCardStep(note);
}
