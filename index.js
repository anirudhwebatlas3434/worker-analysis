import 'dotenv/config';
import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import { createClient } from "@supabase/supabase-js";

// --------------------------------------------------
// Environment validation
// --------------------------------------------------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing Supabase environment variables');
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

// Validate API key format
const apiKey = process.env.OPENAI_API_KEY.trim();
if (!apiKey.startsWith('sk-')) {
  console.error('❌ Invalid OPENAI_API_KEY format - should start with "sk-"');
  console.error('Key preview:', apiKey.substring(0, 10) + '...');
  process.exit(1);
}

console.log('✅ OpenAI API key validated (starts with sk-)');

const app = express();
app.use(express.json());

// --------------------------------------------------
// Supabase client
// --------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --------------------------------------------------
// Validate Supabase connection on startup
// --------------------------------------------------
(async () => {
  const { error } = await supabase
    .from("analysis_queue")
    .select("id")
    .limit(1);

  if (error) {
    console.error("❌ Supabase connection failed:", error.message);
    process.exit(1);
  }

  console.log("✅ Supabase connected successfully");
})();

// --------------------------------------------------
// Routes
// --------------------------------------------------
app.post("/analyze", async (req, res) => {
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: "Missing job_id" });

  // Process asynchronously
  processJob(job_id);
  res.json({ success: true });
});

app.listen(process.env.PORT || 4000, () => {
  console.log("✅ Worker running on", process.env.PORT || 4000);
});

// --------------------------------------------------
// Main job processing function
// --------------------------------------------------
async function processJob(job_id) {
  const jobStartTime = Date.now();
  console.log("🔄 Processing job:", job_id);

  try {
    // Fetch job
    const { data: job, error: jobError } = await supabase
      .from("analysis_queue")
      .select("*")
      .eq("id", job_id)
      .single();

    if (jobError || !job) {
      throw new Error(`Job not found: ${jobError?.message || 'Unknown error'}`);
    }

    // Check retry count
    if (job.retry_count >= job.max_retries) {
      console.error(`Max retries exceeded for job: ${job_id}`);
      await supabase.from("analysis_queue").update({
        status: "failed",
        error_message: `Max retries (${job.max_retries}) exceeded`,
        completed_at: new Date().toISOString()
      }).eq("id", job_id);
      return;
    }

    // Update status to processing
    await supabase.from("analysis_queue").update({
      status: "processing",
      started_at: new Date().toISOString()
    }).eq("id", job_id);

    // Fetch attempt
    const { data: attempt, error: attemptError } = await supabase
      .from("attempts")
      .select("*")
      .eq("id", job.attempt_id)
      .single();

    if (attemptError || !attempt) {
      throw new Error(`Attempt not found: ${attemptError?.message || 'Unknown error'}`);
    }

    // Validate video path
    const videoPath = job.video_url;
    
    if (!videoPath || typeof videoPath !== 'string' || videoPath.trim() === '') {
      throw new Error('Job has empty video path - likely created before video upload completed');
    }

    console.log(`Downloading video from path: ${videoPath}`);

    // Check if file exists first
    const folderPath = videoPath.substring(0, videoPath.lastIndexOf('/'));
    const fileName = videoPath.substring(videoPath.lastIndexOf('/') + 1);
    
    const { data: fileList, error: listError } = await supabase
      .storage
      .from('recordings')
      .list(folderPath);

    if (listError) {
      throw new Error(`Failed to list files in storage: ${listError.message}`);
    }

    const fileExists = fileList?.some(f => f.name === fileName);
    
    if (!fileExists) {
      throw new Error(`Video file not found in storage: ${videoPath}`);
    }

    // Download video
    const { data: videoBlob, error: downloadError } = await supabase
      .storage
      .from("recordings")
      .download(videoPath);

    if (downloadError || !videoBlob || videoBlob.size === 0) {
      throw new Error(`Video download failed: ${downloadError?.message || 'Empty file'}`);
    }

    console.log(
      `Video downloaded: ${(videoBlob.size / 1024 / 1024).toFixed(2)} MB (${videoBlob.size} bytes)`
    );

    // Check Whisper size limit (25 MB)
    const MAX_WHISPER_BYTES = 25 * 1024 * 1024;
    if (videoBlob.size > MAX_WHISPER_BYTES) {
      await supabase.from("analysis_queue").update({
        status: "failed",
        error_message: 'Recording is too large to process. Please record a shorter clip (under ~2 minutes or <25MB).',
        completed_at: new Date().toISOString()
      }).eq("id", job_id);
      return;
    }

    // Verify file format
    const fileExtension = videoPath.substring(videoPath.lastIndexOf('.') + 1).toLowerCase();
    const supportedFormats = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];
    
    if (!supportedFormats.includes(fileExtension)) {
      throw new Error(`Unsupported audio format: ${fileExtension}. Supported formats: ${supportedFormats.join(', ')}`);
    }

    // --------------------------------------------------
    // Whisper Transcription
    // --------------------------------------------------
    const whisperStartTime = Date.now();
    console.log('Transcribing with Whisper (with timestamps)...');

    // Convert Blob to Buffer for form-data
    const arrayBuffer = await videoBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const formData = new FormData();
    formData.append("file", buffer, {
      filename: fileName,
      contentType: videoBlob.type || "video/webm"
    });
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "segment");

    const whisperRes = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...formData.getHeaders()
        },
        body: formData
      }
    );

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      console.error("Whisper error:", errText);
      throw new Error(`Whisper transcription failed: ${errText}`);
    }

    const whisper = await whisperRes.json();
    
    if (!whisper.text) {
      throw new Error('Whisper API returned invalid response: missing text field');
    }

    const transcript = whisper.text;
    const segments = whisper.segments || [];
    const whisperDuration = ((Date.now() - whisperStartTime) / 1000).toFixed(2);
    
    console.log(`Transcription completed in ${whisperDuration}s, length: ${transcript.length}, segments: ${segments.length}`);

    // --------------------------------------------------
    // Speech quality gate
    // --------------------------------------------------
    const wordCount = transcript.trim().split(/\s+/).filter(w => w.length > 0).length;
    const transcriptLength = transcript.trim().length;
    
    // Calculate duration from segments
    const totalDuration = segments.length > 0
      ? segments[segments.length - 1].end
      : 0;
    
    // Detect gibberish
    const avgWordsPerSecond = totalDuration > 0 ? wordCount / totalDuration : 0;
    const isGibberish = wordCount < 15 || 
                        transcriptLength < 50 || 
                        (totalDuration > 10 && avgWordsPerSecond < 0.3);
    
    console.log(`Transcript analysis: ${wordCount} words, ${transcriptLength} chars, ${totalDuration.toFixed(1)}s duration, ${avgWordsPerSecond.toFixed(2)} words/sec`);

    if (isGibberish) {
      console.warn('No meaningful speech detected in recording');
      
      await supabase.from("attempts").update({
        transcript: transcript || '(No speech detected)',
        scores: zeroScores(),
        metrics: {
          wpm: 0,
          fillerRate: 0,
          longestPauseSec: 0,
          eyeContactPct: null,
          headPoseNotes: 'No speech detected in recording'
        },
        feedback: [{
          ts: '00:00',
          note: 'No speech was detected in your recording. Please ensure your microphone is working and speak clearly during the interview.'
        }],
        recommended_articles: [],
        updated_at: new Date().toISOString()
      }).eq("id", attempt.id);

      await completeJob(job_id);
      const processingDuration = ((Date.now() - jobStartTime) / 1000).toFixed(2);
      console.log(`✅ Job completed (no speech detected) in ${processingDuration}s`);
      return;
    }

    // --------------------------------------------------
    // GPT Analysis
    // --------------------------------------------------
    const gptStartTime = Date.now();
    console.log('Analyzing with OpenAI GPT...');

    // Format segments with timestamps
    const segmentsText = segments.map((seg, idx) => {
      const startMin = Math.floor(seg.start / 60);
      const startSec = Math.floor(seg.start % 60);
      const timestamp = `${String(startMin).padStart(2, '0')}:${String(startSec).padStart(2, '0')}`;
      return `[${timestamp}] ${seg.text}`;
    }).join('\n');

    const systemPrompt = `You are a HIGHLY CRITICAL UK medical school MMI examiner with VERY HIGH STANDARDS. You are evaluating candidates for competitive UK medical schools. Your role is to provide HONEST, RIGOROUS assessment based ONLY on what you observe in the transcript.

CRITICAL LANGUAGE REQUIREMENT: Use British English spelling throughout all feedback (e.g., "organised" not "organized", "analyse" not "analyze", "behaviour" not "behavior", "realise" not "realize", "recognise" not "recognize", "practise" as verb/practice as noun, etc.).

CRITICAL ASSESSMENT RULES:
1. Be STRICT - medical school interviews demand excellence
2. NO SYMPATHY SCORING - give the score they deserve, not what you hope they get
3. Vague or generic answers = LOW SCORES (20-40%)
4. Admitting "I don't know" or "winging it" = VERY LOW SCORES (5-20%)
5. Saying almost nothing or irrelevant content = 0-10%
6. Complete silence or single word answers = 0%
7. Lack of structure or evidence = POOR SCORES (15-35%)
8. Good answers with clear examples and reasoning = 65-80%
9. Excellent answers with comprehensive depth = 80-90%
10. Near-perfect, exceptional performance = 90-100%

SCORING GUIDANCE - USE THE FULL RANGE:
- 0-10: No meaningful response, silence, single words, completely off-topic
- 11-25: Extremely poor, admits not knowing, unprepared, incoherent
- 26-40: Poor/inadequate response, major gaps, very vague
- 41-55: Below average, lacks depth, generic platitudes
- 56-65: Average, meets minimal expectations but unremarkable
- 66-75: Good, solid response with some strengths
- 76-85: Very good, clear structure and good insight
- 86-93: Excellent, comprehensive and well-articulated
- 94-100: Outstanding, exceptional depth and professionalism

IMPORTANT: Do NOT be lenient. Medical schools reject most candidates - reflect this in your scoring. If the answer is poor, say so with a low score.

Return a JSON response with this exact structure:

{
  "scores": {
    "Structure": <number 0-100>,
    "Communication": <number 0-100>,
    "Empathy": <number 0-100>,
    "Ethics": <number 0-100>,
    "Professionalism": <number 0-100>,
    "Motivation": <number 0-100>,
    "Teamwork": <number 0-100>,
    "Overall": <number 0-100>
  },
  "metrics": {
    "wpm": <number - calculate from word count and duration>,
    "fillerRate": <decimal 0-1 - count ALL filler words and phrases divided by total words>,
    "longestPauseSec": <number - largest gap between segment timestamps>,
    "eyeContactPct": null,
    "headPoseNotes": "Visual analysis not available from audio transcript"
  },
  "feedback": [
    {"ts": "mm:ss", "note": "<specific critical feedback>"},
    {"ts": "mm:ss", "note": "<specific critical feedback>"}
  ]
}

CRITICAL RULES FOR FEEDBACK:
1. ONLY provide timestamped feedback if you have REAL, SUBSTANTIAL content from the transcript to reference
2. If the transcript is very short (under 30 words total) or unclear - provide ONLY ONE feedback item explaining the lack of content
3. You MUST use the EXACT timestamps from the transcript (format: mm:ss)
4. Each feedback note MUST reference what the candidate ACTUALLY SAID at that specific timestamp
5. NEVER invent or hallucinate things the candidate didn't say
6. For normal-length responses: provide 3-5 feedback items spread across the interview
7. Be SPECIFIC and CRITICAL - point out weaknesses, vagueness, lack of examples`;

    const userPrompt = `Here is the timestamped transcript of the candidate's MMI interview response:

${segmentsText}

TRANSCRIPT STATS:
- Total word count: ${wordCount} words
- Total duration: ${totalDuration.toFixed(1)} seconds
- Character count: ${transcriptLength} characters

ASSESSMENT INSTRUCTIONS:
1. Calculate WPM from the total word count and total duration
2. Calculate filler rate by counting ALL filler words/phrases divided by total words
3. Calculate longest pause from gaps between segment timestamps
4. Set eyeContactPct to null (cannot be determined from transcript)
5. CRITICALLY assess the CONTENT - be HARSH and HONEST, not lenient
6. If they said very little (under 30 words) - scores should be 0-10% and provide ONLY ONE feedback item
7. DO NOT HALLUCINATE - only reference what was ACTUALLY said in the transcript above

REMEMBER: Use the FULL scoring range 0-100. Don't artificially inflate scores.`;

    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 1000,
        temperature: 0.3
      })
    });

    if (!gptRes.ok) {
      const errText = await gptRes.text();
      throw new Error(`GPT analysis failed: ${errText}`);
    }

    const gptJson = await gptRes.json();
    const gptContent = gptJson.choices[0].message.content;
    const gptDuration = ((Date.now() - gptStartTime) / 1000).toFixed(2);
    console.log(`GPT analysis completed in ${gptDuration}s`);

    let analysis;
    try {
      analysis = JSON.parse(gptContent);
    } catch (parseError) {
      throw new Error(`Invalid GPT response format: ${parseError.message}`);
    }

    // Validate and set defaults for analysis structure
    if (!analysis.scores || typeof analysis.scores !== 'object') {
      throw new Error('GPT response missing required field: scores');
    }

    if (!analysis.metrics || typeof analysis.metrics !== 'object') {
      console.warn('GPT response missing metrics, using defaults');
      analysis.metrics = {
        wpm: 0,
        fillerRate: 0,
        longestPauseSec: 0,
        eyeContactPct: null,
        headPoseNotes: 'Visual analysis not available from audio transcript'
      };
    } else {
      analysis.metrics = {
        wpm: analysis.metrics.wpm || 0,
        fillerRate: analysis.metrics.fillerRate || 0,
        longestPauseSec: analysis.metrics.longestPauseSec || 0,
        eyeContactPct: null,
        headPoseNotes: 'Visual analysis not available from audio transcript'
      };
    }

    if (!analysis.feedback || !Array.isArray(analysis.feedback)) {
      console.warn('GPT response missing feedback, using empty array');
      analysis.feedback = [];
    } else {
      analysis.feedback = analysis.feedback.filter(item =>
        item && typeof item === 'object' && item.ts && item.note
      );
    }

    // CRITICAL: Cap scores at 30% for responses <= 2 minutes
    if (totalDuration <= 120) {
      console.log(`Response duration ${totalDuration.toFixed(1)}s <= 2 minutes - capping all scores at 30%`);
      
      for (const key in analysis.scores) {
        if (analysis.scores[key] > 30) {
          console.log(`  Capping ${key}: ${analysis.scores[key]} -> 30`);
          analysis.scores[key] = 30;
        }
      }
      
      const hasTimeFeedback = analysis.feedback.some(f =>
        f.note && (f.note.toLowerCase().includes('duration') || 
                   f.note.toLowerCase().includes('length') || 
                   f.note.toLowerCase().includes('time'))
      );
      
      if (!hasTimeFeedback) {
        analysis.feedback.unshift({
          ts: '00:00',
          note: `Response duration (${Math.floor(totalDuration / 60)}:${String(Math.floor(totalDuration % 60)).padStart(2, '0')}) is significantly below the expected 7-minute timeframe for MMI stations. In real interviews, responses under 2 minutes typically receive a maximum of 30% as they lack sufficient depth and development. Aim for at least 4-5 minutes to demonstrate comprehensive understanding.`
        });
      }
    }

    // --------------------------------------------------
    // Fetch context for article recommendations
    // --------------------------------------------------
    console.log('Generating article recommendations...');
    
    const { data: stationData } = await supabase
      .from('stations')
      .select('title, prompt, themes, role_play, graph_data, difficulty')
      .eq('id', attempt.station_ids[0])
      .single();
    
    const { data: availableArticles } = await supabase
      .from('articles')
      .select('id, title, category, tags, difficulty');
    
    const recommendedArticleIds = generateArticleRecommendations(
      analysis.scores,
      availableArticles || [],
      stationData
    );

    // --------------------------------------------------
    // Update attempt with results
    // --------------------------------------------------
    await supabase.from("attempts").update({
      transcript,
      scores: analysis.scores,
      metrics: analysis.metrics,
      feedback: analysis.feedback,
      recommended_articles: recommendedArticleIds,
      updated_at: new Date().toISOString()
    }).eq("id", attempt.id);

    await completeJob(job_id);
    const processingDuration = ((Date.now() - jobStartTime) / 1000).toFixed(2);
    console.log(`✅ Job completed in ${processingDuration}s`);

  } catch (err) {
    console.error("❌ Worker error:", err.message);
    
    // Get current retry count and update job
    try {
      const { data: currentJob } = await supabase
        .from('analysis_queue')
        .select('retry_count, max_retries')
        .eq('id', job_id)
        .single();
      
      const newRetryCount = (currentJob?.retry_count || 0) + 1;
      const maxRetries = currentJob?.max_retries || 3;
      
      await supabase.from("analysis_queue").update({
        status: newRetryCount >= maxRetries ? 'failed' : 'pending',
        error_message: err.message,
        completed_at: newRetryCount >= maxRetries ? new Date().toISOString() : null,
        retry_count: newRetryCount
      }).eq("id", job_id);
      
      console.log(`Job ${job_id} marked as ${newRetryCount >= maxRetries ? 'failed' : 'pending for retry'} (retry ${newRetryCount}/${maxRetries})`);
    } catch (e) {
      console.error('Failed to mark job as failed:', e);
    }
  }
}

// --------------------------------------------------
// Helper functions
// --------------------------------------------------
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

async function completeJob(job_id) {
  await supabase.from("analysis_queue").update({
    status: "completed",
    completed_at: new Date().toISOString()
  }).eq("id", job_id);
}

function generateArticleRecommendations(scores, availableArticles, stationData) {
  if (!availableArticles || availableArticles.length === 0) {
    return [];
  }

  // Score mapping for weak areas
  const scoreMapping = {
    'Structure': ['frameworks-techniques', 'STAR', 'Signposting', 'Answer Structure', 'framework', 'structure'],
    'Communication': ['performance-skills', 'Body Language', 'Communication Skills', 'Clarity', 'communication', 'interpersonal'],
    'Empathy': ['clinical-scenarios', 'Patient Care', 'Emotional Intelligence', 'Empathy', 'empathy', 'compassion'],
    'Ethics': ['frameworks-techniques', 'Ethical Dilemmas', 'GMC Guidelines', 'Medical Ethics', 'ethics', 'law'],
    'Professionalism': ['performance-skills', 'Professionalism', 'Interview Etiquette', 'Dress Code', 'professionalism', 'integrity'],
    'Motivation': ['specialty-preparation', 'Personal Statement', 'Career Goals', 'Motivation', 'motivation', 'insight'],
    'Teamwork': ['clinical-scenarios', 'Teamwork', 'Leadership', 'Collaboration', 'teamwork', 'leadership']
  };

  // Find weak areas (scores < 75)
  const weakAreas = [];
  for (const [area, score] of Object.entries(scores)) {
    if (area !== 'Overall' && score < 75) {
      weakAreas.push({ area, score });
    }
  }
  weakAreas.sort((a, b) => a.score - b.score);

  // Score articles by relevance
  const articleScores = new Map();
  
  for (const article of availableArticles) {
    let score = 0;
    
    // Score based on weak areas
    for (let i = 0; i < Math.min(weakAreas.length, 3); i++) {
      const weakArea = weakAreas[i];
      const keywords = scoreMapping[weakArea.area] || [];
      
      const categoryMatch = keywords.some(kw =>
        article.category.toLowerCase().includes(kw.toLowerCase())
      );
      const tagMatch = article.tags && keywords.some(kw =>
        article.tags.some(tag => tag.toLowerCase().includes(kw.toLowerCase()))
      );
      const titleMatch = keywords.some(kw =>
        article.title.toLowerCase().includes(kw.toLowerCase())
      );
      
      if (categoryMatch || tagMatch || titleMatch) {
        score += (15 - i * 3);
      }
    }
    
    // Score based on station context
    if (stationData) {
      if (stationData.role_play) {
        if (article.tags?.some(t =>
          /communication|interpersonal|breaking bad news|spikes|role|patient|interaction/i.test(t)
        )) {
          score += 8;
        }
      }
      
      if (stationData.graph_data) {
        if (article.tags?.some(t =>
          /data|graph|chart|interpret|analysis|statistics/i.test(t)
        )) {
          score += 8;
        }
      }
    }
    
    if (score > 0) {
      articleScores.set(article.id, score);
    }
  }
  
  // Get top 3 articles
  const rankedArticles = Array.from(articleScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, 3);
  
  // Fill with general articles if needed
  if (rankedArticles.length < 3) {
    const generalArticles = availableArticles
      .filter(a => !rankedArticles.includes(a.id))
      .slice(0, 3 - rankedArticles.length)
      .map(a => a.id);
    
    return [...rankedArticles, ...generalArticles];
  }
  
  return rankedArticles;
}