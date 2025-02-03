import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { num2 } from "https://cdn.jsdelivr.net/npm/@gramex/ui@0.3/dist/format.js";

const $tokenValue = document.querySelector("#token-value");
const $audio = document.querySelector("#audio");
const $start = document.querySelector("#start");
const $stop = document.querySelector("#stop");
const $transcript = document.querySelector("#transcript");
const $input = document.querySelector("#input");
const $inputForm = document.querySelector("#input-form");

let session;
let pc;
let dc;
let responses;

async function getSession() {
  const { token } = await fetch("https://llmfoundry.straive.com/token", { credentials: "include" }).then((r) =>
    r.json()
  );
  const response = await fetch("https://llmfoundry.straive.com/openai/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}:llmfoundry-talk`,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-realtime-preview-2024-12-17",
      voice: "alloy",
      instructions: document.querySelector("#instructions").value,
      temperature: 0.8,
      input_audio_transcription: { model: "whisper-1" },
      // tools: []
    }),
  });

  return response.json();
}

document.querySelector("#start").addEventListener("click", async (e) => {
  e.preventDefault();

  $inputForm.classList.remove("d-none");
  render(html`<div class="spinner-grow spinner-grow-sm text-secondary me-2" role="status"></div> `, $transcript);

  responses = {};
  session = await getSession();
  console.log("Session ", session);
  // Create a peer connection
  pc = new RTCPeerConnection();
  $start.classList.add("d-none");
  $stop.classList.remove("d-none");
  // Set up to play remote audio from the model
  pc.ontrack = (e) => ($audio.srcObject = e.streams[0]);

  // Add local audio track for microphone input in the browser
  const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
  pc.addTrack(ms.getTracks()[0]);
  // Set up data channel for sending and receiving events
  // - error
  // - session.{created,updated}
  // - conversation.item.{created,input_audio_transcription.{completed,failed},truncated,deleted}
  // - input_audio_buffer.{committed,cleared,speech_started,speech_stopped}
  // - rate_limits.updated
  dc = pc.createDataChannel("oai-events");
  dc.addEventListener("message", (e) => {
    const r = responses;
    const d = JSON.parse(e.data);
    // console.log(d)
    if (d.type.match(/^response\.(created|done)$/)) r[d.response.id] = d.response;
    else if (d.type.match(/^response\.output_item\.(added|done)$/)) r[d.response_id].output[d.output_index] = d.item;
    else if (d.type.match(/^response\.content_part\.(added|done)$/))
      r[d.response_id].output[d.output_index].content[d.content_index] = d.part;
    else if (d.type.match(/^response\.audio_transcript\.(delta|done)$/))
      update(r[d.response_id].output[d.output_index].content[d.content_index], "transcript", d);
    else if (d.type.match(/^response\.text\.(delta|done)$/))
      update(r[d.response_id].output[d.output_index].content[d.content_index], "text", d);
    else if (d.type.match(/^response\.audio\.(delta|done)$/))
      update(r[d.response_id].output[d.output_index].content[d.content_index], "audio", d);
    else if (d.type.match(/^response\.function_call_arguments\.(delta|done)$/))
      update(r[d.response_id].output[d.output_index], "arguments", d);
    else console.log(d);
    renderLogs();
  });
  // Start the session using the Session Description Protocol (SDP)
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // console.log(offer.sdp)
  const baseUrl = "https://api.openai.com/v1/realtime";
  const model = "gpt-4o-mini-realtime-preview-2024-12-17";
  const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
    method: "POST",
    body: offer.sdp,
    headers: { Authorization: `Bearer ${session.client_secret.value}`, "Content-Type": "application/sdp" },
  });
  const answer = { type: "answer", sdp: await sdpResponse.text() };
  await pc.setRemoteDescription(answer);
});

function update(node, key, object) {
  if (object.delta) node[key] = (node[key] ?? "") + object.delta;
  else if (object[key]) node[key] = object[key];
}

function renderLogs() {
  const tokens = { ti: 0, tc: 0, to: 0, ai: 0, ac: 0, ao: 0 };
  for (const response of Object.values(responses)) {
    tokens.ti += response?.usage?.input_token_details?.text_tokens ?? 0;
    tokens.tc += response?.usage?.input_token_details?.cached_token_details?.text_tokens ?? 0;
    tokens.to += response?.usage?.output_token_details?.text_tokens ?? 0;
    tokens.ai += response?.usage?.input_token_details?.audio_tokens ?? 0;
    tokens.ac += response?.usage?.input_token_details?.cached_token_details?.audio_tokens ?? 0;
    tokens.ao += response?.usage?.output_token_details?.audio_tokens ?? 0;
  }
  const costs = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, v * pricing[session.model][k]]));
  const cost = Object.values(costs).reduce((a, b) => a + b, 0);
  render(
    html`
      <div class="row align-items-center rounded p-2 mb-3">
        <div class="col-auto">
          ${pc ? html`<div class="spinner-grow spinner-grow-sm text-danger me-2" role="status"></div>` : null}
          <span class="fw-bold">Total: ${num2(cost / 1e4)}c</span>
        </div>
        <div class="col-auto">
          <span class="me-2">Audio: ${num2((costs.ai + costs.ao + costs.ac) / 1e4)}c</span>
          <span class="text-nowrap">
            <span><i class="bi bi-mic-fill text-primary"></i> ${num2(costs.ai / 1e4)}c</span>
            <span><i class="bi bi-volume-up-fill text-success"></i> ${num2(costs.ao / 1e4)}c</span>
            <span><i class="bi bi-clock-fill text-secondary"></i> ${num2(costs.ac / 1e4)}c</span>
          </span>
        </div>
        <div class="col-auto">
          <span class="me-2">Text: ${num2((costs.ti + costs.to + costs.tc) / 1e4)}c</span>
          <span class="text-nowrap">
            <span><i class="bi bi-chat-fill text-primary"></i> ${num2(costs.ti / 1e4)}c</span>
            <span><i class="bi bi-reply-fill text-success"></i> ${num2(costs.to / 1e4)}c</span>
            <span><i class="bi bi-clock-fill text-secondary"></i> ${num2(costs.tc / 1e4)}c</span>
          </span>
        </div>
      </div>

      <pre style="max-height: 50vh; overflow-y: auto; white-space: pre-wrap">
${Object.values(responses).map((r) =>
          (r?.output ?? []).map((o) =>
            (o.content ?? []).map((c) => html`<p><strong>Assistant:</strong> ${c.text ?? c.transcript}</p>`)
          )
        )}</pre
      >
    `,
    $transcript
  );
}
document.querySelector("#stop").addEventListener("click", () => {
  pc.close();
  pc = null;
  $stop.classList.add("d-none");
  $start.classList.remove("d-none");
  $inputForm.classList.add("d-none");
  renderLogs();
});

$inputForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $input.value;
  if (!text) return;
  const event = {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
  dc.send(JSON.stringify(event));
  dc.send(JSON.stringify({ type: "response.create", response: { modalities: ["text", "audio"] } }));
  $input.value = "";
  $input.focus();
});

const pricing = {
  // ti = text input, tc = text cached, to = text output
  // ai = audio input, ac = audio cached, ao = audio output
  "gpt-4o-mini-realtime-preview-2024-12-17": { ti: 0.6, tc: 0.3, to: 2.4, ai: 10.0, ac: 0.3, ao: 20.0 },
  "gpt-4o-realtime-preview-2024-12-17": { ti: 5.0, tc: 2.5, to: 20.0, ai: 40.0, ac: 2.5, ao: 80.0 },
};
