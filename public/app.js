// Hallmark · genre: editorial · macrostructure: Split Studio · theme: Grid · enrichment: none

const STRIPE_JS = "https://js.stripe.com/v3/";
const RESERVE_LABEL = "Reserve a slot";
const CARD_LABEL = "Put the card on file";
const CARD_RETRY_LABEL = "Load the card field again";
const FALLBACK_EMAIL = "pedro@vezza.com.br";

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

const reservation = { id: null, step: null, clientSecret: null, publishableKey: null };

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

for (const door of document.querySelectorAll(".door")) {
  door.addEventListener("click", () => {
    const direction = door.dataset.direction;

    for (const other of document.querySelectorAll(".door")) {
      const picked = other === door;
      other.dataset.chosen = picked ? "yes" : "no";
      other.setAttribute("aria-pressed", picked ? "true" : "false");
    }

    const radio = form.querySelector(`input[name="direction"][value="${direction}"]`);
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

function lockForm() {
  for (const field of form.querySelectorAll("input, select")) field.disabled = true;
  submit.hidden = true;
}

function unlockForm(label) {
  for (const field of form.querySelectorAll("input, select")) field.disabled = false;
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

async function mountCard() {
  await loadStripe();

  const stripe = window.Stripe(reservation.publishableKey);
  // Read the surface out of the cascade at mount time so the Stripe iframe
  // renders in the page's own tokens. No colour or font literal lives here:
  // --paper is not pure white, and --ink is not the Stripe default grey.
  const shell = getComputedStyle(document.body);
  const elements = stripe.elements({
    clientSecret: reservation.clientSecret,
    appearance: {
      theme: "flat",
      variables: {
        colorBackground: shell.backgroundColor,
        colorText: shell.color,
        fontFamily: shell.fontFamily,
        borderRadius: "0px",
        spacingUnit: "4px",
      },
    },
  });
  const payment = elements.create("payment", { fields: { billingDetails: { email: "never" } } });
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

// The row is written before this runs. So a Stripe failure here must leave the
// visitor with working controls and the truth: the slot is recorded, the card is
// not on file, and there are two ways to finish.
async function openCardStep() {
  busy(submit, true, CARD_RETRY_LABEL);
  say(result, "ok", "Slot recorded. One step left: put a card on file. We charge it nothing.");

  try {
    await mountCard();
  } catch (failure) {
    unlockForm(CARD_RETRY_LABEL);
    say(
      result,
      "error",
      `Slot recorded — that part is done and it stands. The card field did not load (${failure.message}), so no card is on file. Press the button to try it again, or email ${FALLBACK_EMAIL} and we will take the card another way.`,
    );
    return;
  }

  lockForm();
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

  let payload = null;
  try {
    payload = await postJson("/api/reserve", readBody());
  } catch (failure) {
    busy(submit, false, RESERVE_LABEL);
    say(result, "error", failure.message);
    return;
  }

  reservation.id = payload.reservation_id;
  reservation.step = payload.card_step;
  reservation.clientSecret = payload.client_secret;
  reservation.publishableKey = payload.publishable_key;

  if (payload.card_step !== "stripe") {
    lockForm();
    say(result, "ok", "Slot recorded. No card is needed: card capture is not wired up yet, so there is nothing more to do.");
    return;
  }

  await openCardStep();
});
