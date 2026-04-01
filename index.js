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

    // Log response status for debugging
    console.log(`Whisper API response status: ${whisperRes.status}`);

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      console.error("Whisper API error response:", errText);
      throw new Error(`Whisper transcription failed (${whisperRes.status}): ${errText}`);
    }

    let whisper;
    try {
      const responseText = await whisperRes.text();
      console.log('Whisper API raw response preview:', responseText.substring(0, 200));
      whisper = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse Whisper response:', parseError.message);
      throw new Error(`Whisper API returned invalid JSON: ${parseError.message}`);
    }

    // More robust validation of Whisper response
    if (!whisper || typeof whisper !== 'object') {
      console.error('Whisper response is not an object:', whisper);
      throw new Error('Whisper API returned invalid response: not an object');
    }

    // Check for text field with multiple fallbacks
    let transcript = '';
    let segments = [];

    if (whisper.text !== undefined && whisper.text !== null) {
      transcript = String(whisper.text).trim();
    } else if (whisper.segments && Array.isArray(whisper.segments)) {
      // Try to reconstruct text from segments if main text field is missing
      transcript = whisper.segments.map(seg => seg.text || '').join(' ').trim();
      console.log('Reconstructed transcript from segments');
    } else {
      console.error('Whisper response structure:', JSON.stringify(whisper, null, 2));
      throw new Error('Whisper API returned invalid response: missing both text field and segments');
    }

    // Get segments if available
    if (whisper.segments && Array.isArray(whisper.segments)) {
      segments = whisper.segments;
    } else {
      console.warn('Whisper response missing segments array, creating single segment');
      segments = [{
        start: 0,
        end: whisper.duration || 0,
        text: transcript
      }];
    }

    const whisperDuration = ((Date.now() - whisperStartTime) / 1000).toFixed(2);
    
    console.log(`Transcription completed in ${whisperDuration}s`);
    console.log(`Transcript length: ${transcript.length} chars`);
    console.log(`Segments: ${segments.length}`);
    console.log(`Transcript preview: ${transcript.substring(0, 100)}...`);

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
      
      const emptyExaminerNoticed = {
        summary: 'No speech was detected in your recording. The examiner could not assess your performance.',
        key_strengths: [],
        priority_improvements: ['Ensure your microphone is working and positioned correctly', 'Speak clearly and at a moderate pace during the interview'],
        notable_moments: []
      };
      
      const emptyAnnotatedTranscript = segments.map((seg, idx) => {
        const startMin = Math.floor(seg.start / 60);
        const startSec = Math.floor(seg.start % 60);
        return {
          segment_index: idx,
          timestamp: `${String(startMin).padStart(2, '0')}:${String(startSec).padStart(2, '0')}`,
          text: seg.text || '',
          annotations: []
        };
      });
      
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
        coaching_cues: [],
        annotated_transcript: emptyAnnotatedTranscript,
        examiner_noticed: emptyExaminerNoticed,
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
  "coaching_cues": [
    {
      "type": "pacing|structure|depth|linking",
      "content": "<specific actionable coaching cue>",
      "timestamp": <number - seconds from start, or null if general>,
      "severity": "strength|improvement|critical",
      "criterion": "Structure|Communication|Empathy|Ethics|Professionalism|Motivation|Teamwork|General"
    }
  ],
  "annotated_transcript": [
    {
      "segment_index": <number>,
      "timestamp": "mm:ss",
      "text": "<segment text>",
      "annotations": [
        {
          "type": "strength|improvement",
          "note": "<brief annotation>",
          "criterion": "Structure|Communication|Empathy|Ethics|Professionalism|Motivation|Teamwork"
        }
      ]
    }
  ],
  "examiner_noticed": {
    "summary": "<2-3 sentence overall impression>",
    "key_strengths": ["<strength 1>", "<strength 2>"],
    "priority_improvements": ["<improvement 1>", "<improvement 2>"],
    "notable_moments": [
      {
        "timestamp": "mm:ss",
        "description": "<what the examiner noticed at this moment>"
      }
    ]
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
7. Be SPECIFIC and CRITICAL - point out weaknesses, vagueness, lack of examples

COACHING CUES GUIDELINES:
- Generate 4-8 coaching cues covering: pacing (speed/rushing/pauses), structure (organization/signposting), depth (detail/examples), linking (connections between ideas)
- Each cue MUST reference a specific timestamp where the issue/strength occurs (except general cues)
- Use severity: "strength" for things done well, "improvement" for moderate issues, "critical" for serious problems
- Be SPECIFIC and ACTIONABLE - e.g., "At 01:23, you rushed through your key example. Slow down and emphasise the patient impact."

ANNOTATED TRANSCRIPT GUIDELINES:
- For each transcript segment, analyze and add inline annotations marking strengths and improvements
- Annotations must reference specific criteria (Structure, Communication, Empathy, Ethics, Professionalism, Motivation, Teamwork)
- Focus on the most significant 1-2 points per segment (not every minor issue)
- Use direct quotes or references to what was actually said

EXAMINER NOTICED GUIDELINES:
- summary: A concise 2-3 sentence impression that captures the overall candidate performance
- key_strengths: 1-2 specific strengths that stood out (can be empty if none)
- priority_improvements: 1-2 highest-priority areas for improvement (focus on what would most improve their score)
- notable_moments: Key timestamps where something significant happened (impressive answer, major gap, recovery, etc.)`;

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
8. Generate coaching cues covering pacing, structure, depth, and linking with specific timestamps
9. Annotate each transcript segment with 0-2 inline annotations (strengths/improvements)
10. Create a concise Examiner Noticed summary with key strengths, priority improvements, and notable moments

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

    // Validate and process coaching_cues with 30-second grace period
    const GRACE_PERIOD_SECONDS = 30;
    if (!analysis.coaching_cues || !Array.isArray(analysis.coaching_cues)) {
      console.warn('GPT response missing coaching_cues, using empty array');
      analysis.coaching_cues = [];
    } else {
      analysis.coaching_cues = analysis.coaching_cues
        .filter(cue => cue && typeof cue === 'object' && cue.type && cue.content)
        .map(cue => ({
          type: cue.type || 'general',
          content: cue.content,
          timestamp: cue.timestamp !== undefined ? cue.timestamp : null,
          severity: cue.severity || 'improvement',
          criterion: cue.criterion || 'General',
          // Mark cues that fall within grace period
          is_grace_period: cue.timestamp !== null && cue.timestamp !== undefined && cue.timestamp < GRACE_PERIOD_SECONDS
        }));
    }
    
    const gracePeriodCueCount = analysis.coaching_cues.filter(c => c.is_grace_period).length;
    const activeCueCount = analysis.coaching_cues.filter(c => !c.is_grace_period).length;
    console.log(`Coaching cues: ${analysis.coaching_cues.length} total (${gracePeriodCueCount} in grace period, ${activeCueCount} active)`);

    // Validate annotated_transcript
    if (!analysis.annotated_transcript || !Array.isArray(analysis.annotated_transcript)) {
      console.warn('GPT response missing annotated_transcript, generating from segments');
      analysis.annotated_transcript = segments.map((seg, idx) => {
        const startMin = Math.floor(seg.start / 60);
        const startSec = Math.floor(seg.start % 60);
        return {
          segment_index: idx,
          timestamp: `${String(startMin).padStart(2, '0')}:${String(startSec).padStart(2, '0')}`,
          text: seg.text || '',
          annotations: []
        };
      });
    } else {
      analysis.annotated_transcript = analysis.annotated_transcript
        .filter(item => item && typeof item === 'object')
        .map((item, idx) => ({
          segment_index: item.segment_index !== undefined ? item.segment_index : idx,
          timestamp: item.timestamp || '00:00',
          text: item.text || '',
          annotations: Array.isArray(item.annotations) 
            ? item.annotations.filter(a => a && a.type && a.note)
            : []
        }));
    }
    console.log(`Annotated transcript segments: ${analysis.annotated_transcript.length}`);

    // Validate examiner_noticed
    if (!analysis.examiner_noticed || typeof analysis.examiner_noticed !== 'object') {
      console.warn('GPT response missing examiner_noticed, generating from cues');
      analysis.examiner_noticed = generateExaminerNoticedFallback(analysis.coaching_cues, analysis.scores);
    } else {
      analysis.examiner_noticed = {
        summary: analysis.examiner_noticed.summary || 'No summary available.',
        key_strengths: Array.isArray(analysis.examiner_noticed.key_strengths) 
          ? analysis.examiner_noticed.key_strengths.filter(s => typeof s === 'string')
          : [],
        priority_improvements: Array.isArray(analysis.examiner_noticed.priority_improvements)
          ? analysis.examiner_noticed.priority_improvements.filter(i => typeof i === 'string')
          : [],
        notable_moments: Array.isArray(analysis.examiner_noticed.notable_moments)
          ? analysis.examiner_noticed.notable_moments.filter(m => m && m.timestamp && m.description)
          : []
      };
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
      coaching_cues: analysis.coaching_cues,
      annotated_transcript: analysis.annotated_transcript,
      examiner_noticed: analysis.examiner_noticed,
      recommended_articles: recommendedArticleIds,
      updated_at: new Date().toISOString()
    }).eq("id", attempt.id);

    await completeJob(job_id);
    const processingDuration = ((Date.now() - jobStartTime) / 1000).toFixed(2);
    console.log(`✅ Job completed in ${processingDuration}s`);

  } catch (err) {
    console.error("❌ Worker error:", err.message);
    console.error("Error stack:", err.stack);
    
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

function generateExaminerNoticedFallback(coachingCues, scores) {
  const strengths = coachingCues
    .filter(c => c.severity === 'strength')
    .slice(0, 2)
    .map(c => c.content);
  
  const improvements = coachingCues
    .filter(c => c.severity === 'critical' || c.severity === 'improvement')
    .slice(0, 2)
    .map(c => c.content);
  
  const notableMoments = coachingCues
    .filter(c => c.timestamp !== null && c.timestamp !== undefined)
    .slice(0, 3)
    .map(c => {
      const min = Math.floor(c.timestamp / 60);
      const sec = Math.floor(c.timestamp % 60);
      return {
        timestamp: `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`,
        description: `${c.type}: ${c.content.substring(0, 100)}${c.content.length > 100 ? '...' : ''}`
      };
    });
  
  const overallScore = scores?.Overall || 0;
  let summary = 'No meaningful speech detected in this recording.';
  if (overallScore > 0) {
    if (overallScore < 30) {
      summary = 'The candidate showed limited engagement with the question, requiring significant development in all assessed areas.';
    } else if (overallScore < 60) {
      summary = 'The candidate demonstrated some understanding but showed considerable room for improvement across multiple criteria.';
    } else if (overallScore < 80) {
      summary = 'The candidate performed reasonably well with some notable strengths, though several areas could be strengthened.';
    } else {
      summary = 'The candidate delivered a strong performance with clear evidence of good preparation and understanding.';
    }
  }
  
  return {
    summary,
    key_strengths: strengths,
    priority_improvements: improvements,
    notable_moments: notableMoments
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