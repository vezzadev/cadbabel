// Hallmark · genre: editorial · macrostructure: Split Studio · theme: Grid · enrichment: none

const STRIPE_JS = "https://js.stripe.com/v3/";

const form = document.getElementById("reserve-form");
const submit = document.getElementById("reserve-submit");
const result = document.getElementById("reserve-result");
const cardStep = document.getElementById("card-step");
const cardMount = document.getElementById("card-mount");
const cardSubmit = document.getElementById("card-submit");
const cardResult = document.getElementById("card-result");
const plate = document.getElementById("disclosure");

// The timestamp we report is the moment the disclosure actually entered the
// viewport, not page load. If IntersectionObserver never fires we have not
// observed it being read, so the field stays null and submission is blocked.
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
      other.dataset.chosen = other === door ? "yes" : "no";
    }

    const radio = form.querySelector(`input[name="direction"][value="${direction}"]`);
    if (radio) radio.checked = true;
    say(document.getElementById("direction-help"), "ok", "We copied this from the direction you picked above. Change it here if you like.");

    recordEvent("door_select", direction);

    document.getElementById("reserve").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("purpose").focus({ preventScroll: true });
  });
}

// ─── reservation ───

function readForm() {
  const direction = form.querySelector('input[name="direction"]:checked');
  const purpose = document.getElementById("purpose");
  const neededBy = document.getElementById("needed_by");
  const email = document.getElementById("email");
  const ack = document.getElementById("disclosure_ack");

  const problems = [];

  if (!direction) problems.push([document.getElementById("direction-help"), "Pick a direction first."]);
  if (!purpose.value) problems.push([document.getElementById("purpose-help"), "Tell us what the part is for."]);
  if (!email.value.trim()) problems.push([document.getElementById("email-help"), "We need an email to reply to."]);
  if (!ack.checked) problems.push([document.getElementById("ack-help"), "Confirm you have read the disclosure."]);
  if (!disclosureShownAt) {
    problems.push([document.getElementById("ack-help"), "Read the disclosure above before you reserve."]);
  }

  email.setAttribute("aria-invalid", email.value.trim() ? "false" : "true");

  return {
    problems,
    body: {
      email: email.value.trim(),
      direction: direction ? direction.value : null,
      purpose: purpose.value,
      needed_by: neededBy.value || null,
      disclosure_ack: ack.checked,
      disclosure_shown_at: disclosureShownAt,
    },
  };
}

async function mountCard() {
  if (!window.Stripe) {
    await new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = STRIPE_JS;
      tag.onload = resolve;
      tag.onerror = () => reject(new Error("could not load Stripe"));
      document.head.append(tag);
    });
  }

  const stripe = window.Stripe(reservation.publishableKey);
  const elements = stripe.elements({
    clientSecret: reservation.clientSecret,
    appearance: {
      theme: "flat",
      variables: {
        colorBackground: "#ffffff",
        colorText: "#20242c",
        fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif",
        borderRadius: "0px",
        spacingUnit: "4px",
      },
    },
  });
  const payment = elements.create("payment", { fields: { billingDetails: { email: "never" } } });
  payment.mount(cardMount);

  cardStep.hidden = false;
  say(cardResult, "idle", "");

  cardSubmit.addEventListener("click", async () => {
    busy(cardSubmit, true, "Put the card on file");
    say(cardResult, "idle", "");

    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { payment_method_data: { billing_details: { email: form.email.value.trim() } } },
      redirect: "if_required",
    });

    if (error) {
      busy(cardSubmit, false, "Put the card on file");
      say(cardResult, "error", error.message || "The card was not accepted.");
      return;
    }

    try {
      await postJson("/api/reserve/confirm", {
        reservation_id: reservation.id,
        setup_intent_id: setupIntent.id,
      });
      say(cardResult, "ok", "Card on file, and we charged it nothing. You get a reply within a day that repeats the disclosure.");
      cardSubmit.textContent = "Done";
    } catch (failure) {
      busy(cardSubmit, false, "Put the card on file");
      say(cardResult, "error", failure.message);
    }
  });
}

form.addEventListener("submit", async event => {
  event.preventDefault();

  for (const helper of form.querySelectorAll(".helper")) {
    if (helper.dataset.state === "error") say(helper, "idle", "");
  }

  const { problems, body } = readForm();
  if (problems.length > 0) {
    for (const [node, message] of problems) say(node, "error", message);
    say(result, "error", "Fix the fields above.");
    problems[0][0].scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  busy(submit, true, "Reserve a slot");
  say(result, "idle", "");

  try {
    const payload = await postJson("/api/reserve", body);
    reservation.id = payload.reservation_id;
    reservation.step = payload.card_step;
    reservation.clientSecret = payload.client_secret;
    reservation.publishableKey = payload.publishable_key;

    for (const field of form.querySelectorAll("input, select")) field.disabled = true;
    submit.hidden = true;

    if (payload.card_step !== "stripe") {
      say(result, "ok", "Slot recorded. No card is needed: card capture is not wired up yet, so there is nothing more to do.");
      return;
    }

    say(result, "ok", "Slot recorded. One step left: put a card on file. We charge it nothing.");
    await mountCard();
  } catch (failure) {
    busy(submit, false, "Reserve a slot");
    say(result, "error", failure.message);
  }
});
