import 'dotenv/config';
import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// Verify environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* -------------------------------------------------- */
/* ENTRY POINT */
/* -------------------------------------------------- */
app.post("/analyze", async (req, res) => {
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: "Missing job_id" });

  processJob(job_id); // fire-and-forget
  res.json({ success: true });
});

app.listen(process.env.PORT || 4000, () =>
  console.log("✅ Background worker running")
);

/* -------------------------------------------------- */
/* MAIN JOB PROCESSOR */
/* -------------------------------------------------- */
async function processJob(job_id) {
  const start = Date.now();
  console.log("🔄 Processing job:", job_id);

  try {
    /* -------- Fetch job -------- */
    const { data: job } = await supabase
      .from("analysis_queue")
      .select("*")
      .eq("id", job_id)
      .single();

    if (!job) throw new Error("Job not found");

    await supabase
      .from("analysis_queue")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", job_id);

    /* -------- Fetch attempt -------- */
    const { data: attempt } = await supabase
      .from("attempts")
      .select("*")
      .eq("id", job.attempt_id)
      .single();

    if (!attempt) throw new Error("Attempt not found");

    /* -------- Download video -------- */
    const videoPath = job.video_url;
    const fileName = videoPath.split("/").pop();

    const { data: videoBlob } = await supabase
      .storage
      .from("recordings")
      .download(videoPath);

    if (!videoBlob || videoBlob.size === 0) {
      throw new Error("Invalid video file");
    }

    /* -------- Whisper transcription -------- */
    const fd = new FormData();
    fd.append("file", videoBlob, fileName);
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "segment");

    const whisperRes = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: fd
      }
    );

    if (!whisperRes.ok) throw new Error("Whisper failed");

    const whisper = await whisperRes.json();
    const transcript = whisper.text || "";
    const segments = whisper.segments || [];

    /* -------- Speech quality check -------- */
    const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
    const duration =
      segments.length > 0 ? segments[segments.length - 1].end : 0;

    if (wordCount < 15) {
      await supabase.from("attempts").update({
        transcript,
        scores: zeroScores(),
        metrics: zeroMetrics(),
        feedback: [
          {
            ts: "00:00",
            note:
              "No meaningful speech was detected. Please record again with clear audio."
          }
        ],
        recommended_articles: []
      }).eq("id", attempt.id);

      await completeJob(job_id);
      return;
    }

    /* -------- GPT analysis -------- */
    const transcriptForGPT = segments
      .map(
        s =>
          `[${formatTime(s.start)}] ${s.text}`
      )
      .join("\n");

    const gptRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You are a strict UK MMI examiner." },
            { role: "user", content: transcriptForGPT }
          ],
          max_tokens: 1200,
          temperature: 0.3
        })
      }
    );

    if (!gptRes.ok) throw new Error("GPT analysis failed");

    const gptJson = await gptRes.json();
    const analysis = JSON.parse(gptJson.choices[0].message.content);

    /* -------- Update attempt -------- */
    await supabase.from("attempts").update({
      transcript,
      scores: analysis.scores,
      metrics: analysis.metrics,
      feedback: analysis.feedback,
      recommended_articles: analysis.recommended_articles || [],
      updated_at: new Date().toISOString()
    }).eq("id", attempt.id);

    /* -------- Complete job -------- */
    await completeJob(job_id);

    console.log(
      `✅ Job ${job_id} completed in ${(
        (Date.now() - start) /
        1000
      ).toFixed(1)}s`
    );

  } catch (err) {
    console.error("❌ Worker error:", err.message);
    await supabase.from("analysis_queue").update({
      status: "failed",
      error_message: err.message
    }).eq("id", job_id);
  }
}

/* -------------------------------------------------- */
/* HELPERS */
/* -------------------------------------------------- */
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function zeroScores() {
  return {
    Structure: 0,
    Communication: 0,
    Empathy: 0,
    Ethics: 0,
    Professionalism: 0,
    Motivation: 0,
    Teamwork: 0,
    Overall: 0
  };
}

function zeroMetrics() {
  return {
    wpm: 0,
    fillerRate: 0,
    longestPauseSec: 0,
    eyeContactPct: null,
    headPoseNotes: "No speech detected"
  };
}

async function completeJob(job_id) {
  await supabase.from("analysis_queue").update({
    status: "completed",
    completed_at: new Date().toISOString()
  }).eq("id", job_id);
}
