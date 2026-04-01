-- Add new AI feedback columns to attempts table
-- Run these in Supabase SQL Editor

-- Add coaching_cues column for structured pacing/structure/depth/linking cues
ALTER TABLE attempts 
ADD COLUMN IF NOT EXISTS coaching_cues JSONB DEFAULT '[]'::jsonb;

-- Add annotated_transcript column for inline strength/improvement markers
ALTER TABLE attempts 
ADD COLUMN IF NOT EXISTS annotated_transcript JSONB DEFAULT '[]'::jsonb;

-- Add examiner_noticed column for curated cue summary
ALTER TABLE attempts 
ADD COLUMN IF NOT EXISTS examiner_noticed JSONB DEFAULT '{}'::jsonb;

-- Add indexes for better query performance (optional but recommended)
CREATE INDEX IF NOT EXISTS idx_attempts_coaching_cues ON attempts USING GIN (coaching_cues);
CREATE INDEX IF NOT EXISTS idx_attempts_examiner_noticed ON attempts USING GIN (examiner_noticed);
