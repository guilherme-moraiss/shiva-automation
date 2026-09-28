/**
 * Prompt engineering for the remake pipeline.
 *
 * Principle: we recreate the *format* of a trending reel (scene, framing, pose, action, camera, vibe)
 * with our own AI model's identity. We never copy the source creator's face or identity.
 */

export const ANALYSIS_PROMPT = `You are a short-form video strategist and a prompt engineer for AI image/video models.
Watch this Instagram Reel / TikTok and break it down so it can be recreated with a DIFFERENT, fictional AI model as the on-screen person.
Describe the format, not the identity: do not describe the original person's face or identity.

Return ONLY JSON with this exact shape:
{
  "summary": "one sentence: what happens",
  "format": "e.g. POV selfie, mirror video, get-ready-with-me, lip sync, reaction, dance trend, outfit check",
  "hook": "what grabs attention in the first 1-2 seconds",
  "on_screen_text": "text overlay if any, else empty",
  "setting": "location, background, props",
  "lighting": "light source, time of day, color temperature",
  "camera": "framing (close-up/medium/full), angle, distance, handheld/tripod/selfie, movement",
  "outfit": "clothing and accessories (generic, no brands)",
  "start_pose": "body position and expression in the first frame",
  "timeline": [{"t": "0-2s", "action": "..."}],
  "duration_seconds": 0,
  "audio": "trending sound / music vibe / talking / ambience",
  "why_it_works": "why this performs (retention, relatability, curiosity...)",
  "first_frame_prompt": "a detailed photographic description of the FIRST FRAME (setting, framing, pose, outfit, lighting, phone-camera look) with the person described only as 'the woman'",
  "video_prompt": "a Wan 3.0 motion prompt: what 'the woman' does second by second, facial expressions, camera behaviour, audio design, and negative constraints (no text, no extra people, no morphing, no identity change)"
}`;

const joinNonEmpty = (...xs) => xs.filter((x) => x && String(x).trim()).join('\n');

/** Body proportions must be stated explicitly — image models drift towards "average" bodies otherwise. */
/** Identity profile read automatically from the model's photos. */
export const PROFILE_PROMPT = `You write the identity sheet of a fictional adult AI character so an image generator keeps her identical in every picture.
The photos all show the same woman. Look carefully and answer ONLY with JSON:
{
  "hair": "colour, length, texture, usual style",
  "eyes": "colour and shape",
  "skin": "tone and texture",
  "face_marks": "freckles / moles / beauty marks and exactly where, or \"none\"",
  "tattoos": "\"none\" if no tattoo is visible in any photo, otherwise where and what",
  "piercings": "\"none\" if none visible (ignore small earrings only if present — then say \"small earrings only\"), otherwise where",
  "nails": "length and colour",
  "makeup": "usual makeup style",
  "body": "overall build and proportions in neutral fit-model terms",
  "other": "any other constant distinctive trait, or \"\""
}`;

/** Profile JSON → constraint sentence (what must never change). */
export function profileLine(profile) {
  const p = typeof profile === 'string' ? (() => { try { return JSON.parse(profile); } catch { return null; } })() : profile;
  if (!p) return '';
  const none = (v) => !v || /^none$|^no\b|^n\/a$/i.test(String(v).trim());
  const parts = [
    p.hair && `hair: ${p.hair}`, p.eyes && `eyes: ${p.eyes}`, p.skin && `skin: ${p.skin}`,
    !none(p.face_marks) && `face: ${p.face_marks} (always exactly there)`,
    none(p.tattoos) ? 'NO tattoos anywhere — never add any' : `tattoos: ${p.tattoos}`,
    none(p.piercings) ? 'NO piercings — never add any' : `piercings: ${p.piercings}`,
    p.nails && `nails: ${p.nails}`, p.other && `also: ${p.other}`,
  ].filter(Boolean);
  return parts.length ? `Her fixed identity (from her photos — identical in every image): ${parts.join('; ')}.` : '';
}

/** `b` is the body text, or { body, rules, profile } — identity rides along everywhere the body goes. */
export const bodyLine = (b) => {
  const body = b && typeof b === 'object' ? b.body || (() => { try { return JSON.parse(b.profile || '{}').body; } catch { return ''; } })() : b;
  const rules = b && typeof b === 'object' ? b.rules : '';
  const prof = b && typeof b === 'object' ? profileLine(b.profile) : '';
  const main = body && String(body).trim()
    ? `Body shape and proportions to match exactly, as in the body reference photos: ${String(body).trim().replace(/\.$/, '')}.`
    : 'Match her exact body shape and proportions from the body reference photos — do not slim her down or change her figure.';
  return [prof, main, rulesLine(rules), noTattooLine(b), noPiercingLine(b)].filter(Boolean).join('\n');
};

/** True when her rules/profile say she has no tattoos (e.g. "no tattoos anywhere", "sem tatuagens"). */
export function hasNoTattoos(b) {
  if (!b || typeof b !== 'object') return false;
  if (/\b(no|without|sem|nenhuma)\s+(visible\s+)?(tattoos?|tatuage(m|ns))/i.test(String(b.rules || ''))) return true;
  try {
    const t = (typeof b.profile === 'string' ? JSON.parse(b.profile || '{}') : b.profile || {}).tattoos;
    return t !== undefined && t !== null && /^(none|no\b|n\/a|nenhuma)/i.test(String(t).trim());
  } catch { return false; }
}

/** True when her rules/profile say no piercings (e.g. "no piercings except small earrings", "small earrings only"). */
export function hasNoPiercings(b) {
  if (!b || typeof b !== 'object') return false;
  if (/\b(no|without|sem|nenhum)\s+piercings?/i.test(String(b.rules || ''))) return true;
  try {
    const p = (typeof b.profile === 'string' ? JSON.parse(b.profile || '{}') : b.profile || {}).piercings;
    return p !== undefined && p !== null && /^(none|no\b|n\/a|nenhum)|earrings? only|only (small )?earrings?/i.test(String(p).trim());
  } catch { return false; }
}

/** Source creators often have navel/nose piercings that video models copy onto her. */
export const noPiercingLine = (b) => (hasNoPiercings(b)
  ? 'HARD RULE — NO PIERCINGS: only small earlobe earrings — no navel/belly-button piercing, no nose, lip or eyebrow piercing. If the original person has piercings, do NOT copy them.'
  : '');

/**
 * What makes generated people look "AI": beauty-filter skin, heavy red blush, glossy lips, too-perfect light.
 * Stated explicitly in the person swap (photo) and in the exact copy (video).
 */
export const REALISM_PHOTO = 'Unretouched real smartphone photo: natural skin texture with visible pores and fine detail, subtle natural makeup and cheeks (no heavy red blush), natural lips (no glossy filler look), no beauty filter, no skin smoothing, no plastic or waxy look, true-to-life colours.';
export const REALISM_VIDEO = 'Unretouched real smartphone footage: natural skin texture with visible pores, subtle natural makeup and cheeks (no heavy red blush), natural lips, no beauty filter, no skin smoothing, no plastic or waxy look, natural phone-camera exposure, motion blur and sensor noise.';

/** Printed letters/numbers/logos copied from the source come out mirrored or misspelled. */
export const PLAIN_CLOTHES = 'Clothes: if the original garments have printed letters, numbers or logos, make those garments plain (same colour and cut, no text at all) — copied print comes out garbled.';

/**
 * Video models copy tattoos from the source person (or invent them on arms/wrists).
 * Repeated as a hard constraint in every image and video prompt when she has none.
 */
export const noTattooLine = (b) => (hasNoTattoos(b)
  ? 'HARD RULE — NO TATTOOS: she has no tattoos at all — not on her arms, wrists, hands or legs either. If the original person, frame or video has tattoos, do NOT copy them.'
  : '');

/** Identity rules that must hold in every image/video (e.g. "no tattoos anywhere; freckles on nose and cheeks"). */
export const rulesLine = (rules) => rules && String(rules).trim()
  ? `Identity rules — always true for her, in every image: ${String(rules).trim().replace(/\s*\n+\s*/g, '; ').replace(/\.$/, '')}.`
  : '';

export const BODY_DESCRIBE_PROMPT = `You write reference notes for an image-generation model that must reproduce this woman's figure consistently.
Look at the photos (they show the same adult woman, clothed). Describe ONLY her body shape and proportions in one concise English sentence, using neutral, factual fashion/fit-model vocabulary:
overall build, height impression, bust size, waist, hips, glutes, thighs/legs, shoulders — plus skin tone.
Be specific and honest about sizes (e.g. "very large bust", "narrow waist", "wide hips", "large round glutes", "hourglass figure"). No face, no hair, no clothing, no names, no judgement. Output only the sentence.`;

export const SWAP_SYSTEM_PROMPT =
  'You are a precise photo editor. Replace only the person as instructed and keep everything else in the photo unchanged; ' +
  'the new person must look exactly like the reference photos (face, hair, skin, body shape). You must ALWAYS produce an image.';

/** Same editor when her own place replaces the background (a "keep everything" system prompt would keep the original room). */
export const SWAP_PLACE_SYSTEM_PROMPT =
  'You are a precise photo editor. Replace the person and the background exactly as instructed and keep the framing, pose and camera angle unchanged; ' +
  'the new person must look exactly like the reference photos (face, hair, skin, body shape). You must ALWAYS produce an image.';

/**
 * Put HER in a frame/photo — the user's "HARD SUBJECT TRANSFER" prompt (2026-09-27), used by every image editor
 * (Nano Banana, Flux.2, Seedream). Image B = image 1, the scene (reel frame / post photo); Image A = images 2..N,
 * her references. Image A is the only source of the person (face AND body: no text description of her body, which
 * also keeps filter-prone words out); Image B only gives the environment, the pose and the clothes.
 * Kept as an edit of image 1 so the composition stays. Added at the end: her identity rules (no tattoos…), the
 * remake's outfit / setting choice and the user's direction. ownPlace: her room (a "Setting" line + image added by
 * the runner) replaces Image B's background.
 */
export function buildSwapPrompt({ refCount, body, instructions, keepOutfit = true, ownPlace = false, options = null }) {
  const a = refCount === 1 ? 'image 2' : `images 2–${refCount + 1}`;
  const ownClothes = keepOutfit === false;
  const keepClothes = keepOutfit !== 'asset' && !ownClothes;
  const clothing = ownClothes
    ? 'Dress her in a similar casual outfit of her own, like the clothes in Image A. Do not keep the clothing of the person in Image B.'
    : keepOutfit === 'covered'
      ? 'Transfer the clothing from Image B onto the body from Image A, made a little more covered: a higher, closed neckline that fully covers the chest, same style, colours and fabric. Refit the clothing naturally to match Image A’s exact body proportions while preserving the fabric details, folds, wrinkles, tension, drape, and texture. Do not use any clothing from Image A.'
      : 'Transfer the clothing from Image B onto the body from Image A. Refit the clothing naturally to match Image A’s exact body proportions while preserving all fabric details, folds, wrinkles, tension, drape, and texture. Do not use any clothing from Image A.';
  const fromB = [
    !ownPlace && 'background, environment',
    'lighting, shadows, camera angle, framing, depth of field, perspective, exact pose',
    !ownClothes && 'exact clothing/outfit',
  ].filter(Boolean).join(', ');
  return joinNonEmpty(
    'HARD SUBJECT TRANSFER (face + body from Image A | clothing + background + pose from Image B).',
    `Image A = ${a}: reference photos of one woman (the same person in every photo). Image B = image 1: the photo to edit.`,
    'Task: Place the person from Image A into Image B as a full subject replacement. Use Image A for the complete person and Image B only for the environment, clothing, and pose.',
    'Strict source rules:',
    '- Image A is the ONLY source for: face, identity, head shape, skin tone & texture, hair, full body (exact shape, proportions, anatomy, height, build, shoulder width, waist, hips, limb lengths, muscle/fat distribution, and all body details). The final person must be 100% identical to the person in Image A in both face and body.',
    `- Image B is used ONLY for: ${fromB}.`,
    'Instructions:',
    '- Completely remove the original person from Image B.',
    '- Replace them with the person from Image A (face + full body).',
    '- Make the person from Image A perfectly replicate the exact pose from Image B — including head tilt, torso angle, shoulder position, arm and hand placement, leg stance, weight distribution, and overall body orientation — with the same facial expression and mouth position, shown with Image A’s face.',
    `- ${clothing}`,
    ownPlace && '- Background: do not use Image B’s background; use HER room from the setting image (see Setting below), keeping Image B’s framing, camera angle and lighting direction.',
    '- Match the lighting, color grading, shadows, and reflections from Image B onto the subject from Image A for seamless integration.',
    '- Maintain accurate scale, perspective, ground contact, and realistic interaction with the environment.',
    'Strict constraints:',
    '- No blending of identities or faces.',
    '- No mixing of bodies or anatomy.',
    '- Do not use any facial features, body shape, or proportions from Image B.',
    '- No anatomy modification beyond natural adaptation to the new pose.',
    '- Photorealistic result only. No stylization, no beauty filters, no enhancements.',
    body && typeof body === 'object' && rulesLine(body.rules),
    noTattooLine(body),
    noPiercingLine(body),
    keepClothes && PLAIN_CLOTHES,
    ...swapOptionLines(options),
    instructions && `Extra direction (priority): ${instructions}`,
    REALISM_PHOTO,
    'Generate a highly detailed, photorealistic image following these rules exactly. Exactly one person.',
  );
}

/**
 * "Editar imagem": one change to an image that is already right (the reference app's "enlarge" step after the
 * recreation). Only that image goes in, so her face, the outfit and the scene are kept as they are.
 */
export const EDIT_SYSTEM_PROMPT =
  'You are a precise photo editor. Apply only the requested change and keep everything else in the photo exactly the same. ' +
  'She stays fully dressed: every garment stays on, opaque and in place, with at least the coverage it has now; a clothing change may only restyle it.';

/** One-click edits (label PT for the app, instruction EN for the model). bust4x = the reference app's enlargement prompt. */
export const EDIT_PRESETS = {
  bust4x: {
    label: 'Bust 4× bigger',
    text: 'refer to the model, make her boobs four times bigger, do not change anything else',
  },
  bust: {
    label: 'Bigger bust (natural)',
    text: 'Make her breasts noticeably larger and fuller, with a natural shape and realistic proportions for her body. Refit the same clothing naturally over the fuller bust: same garment, same colours, same neckline.',
  },
};

/** Step 3 (Aumento): what every enlargement uses unless her model has its own prompt (Perfis). */
export const ENLARGE_DEFAULT = EDIT_PRESETS.bust4x.text;

/** Step-1 toggles of a remake (reference: "no hairclips", "no tattoos", "change top"). Colours the app offers. */
export const TOP_COLORS = ['black', 'white', 'grey', 'beige', 'brown', 'pink', 'red', 'orange', 'yellow', 'green', 'light blue', 'blue', 'purple'];
export function cleanSwapOptions(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  if (o.noHairclips) out.noHairclips = true;
  if (o.noTattoos) out.noTattoos = true;
  if (TOP_COLORS.includes(o.topColor)) out.topColor = o.topColor;
  return Object.keys(out).length ? out : null;
}
const swapOptionLines = (o) => [
  o?.noHairclips && 'Hair: no hair clips, claw clips, hair ties or hair accessories of any kind; her hair is loose and natural.',
  o?.noTattoos && 'NO TATTOOS: her skin shows no tattoo anywhere (remove every tattoo of the original person).',
  o?.topColor && `Top: change only the colour of her top to ${o.topColor} (same garment, cut, fabric, fit and coverage).`,
].filter(Boolean);

/**
 * The reference app's person swap with Nano Banana Pro (its "nano-banana-pro prompt", default), word for word:
 * image 1 = her photo (identity), image 2 = the video frame to recreate.
 */
export const REF_SWAP_PROMPT = 'Recreate image 2 using identity from image 1, match skin-tone of face with body, same facial expression and pose from image 2, keep hair and face from image 1, keep hairclips from image 1, Keep exact body, outfit, lighting, pose and background from image 2, do not use face from image 2 at all. Use exact body from image 1, eyes open';

/** The reference's swap prompt, plus only her identity rules and the step-1 options chosen ("Sem ganchos" drops the hairclips). */
export function refSwapPrompt({ body, options = null, instructions = '', covered = false } = {}) {
  const base = options?.noHairclips ? REF_SWAP_PROMPT.replace('keep hairclips from image 1, ', '') : REF_SWAP_PROMPT;
  return joinNonEmpty(base,
    covered && 'Outfit: the same outfit as image 2, made a little more covered: a higher, closed neckline that fully covers the chest (same style, colours and fabric).',
    noTattooLine(body), noPiercingLine(body), ...swapOptionLines(options), instructions && `Extra direction (priority): ${instructions}`);
}

/** Her own swap prompt (Perfis), with this remake's options and direction added at the end (never replacing it). */
export function customSwapPrompt(text, { options = null, instructions = '' } = {}) {
  return joinNonEmpty(String(text).trim(), ...swapOptionLines(options), instructions && `Extra direction (priority): ${instructions}`);
}

/**
 * The enlargement (step 3, Automático's aumento, Modelos "Aumentar o peito"): the instruction as the reference sends it,
 * short (a long "keep everything exactly the same" prompt waters "four times bigger" down), still dressed, with her
 * identity rules.
 */
export function buildEnlargePrompt({ change, body }) {
  return joinNonEmpty(String(change).trim(), 'She keeps the same clothes on.', noTattooLine(body), noPiercingLine(body));
}

export function buildImageEditPrompt({ change, body }) {
  return joinNonEmpty(
    'Edit this photo. Change only this:',
    String(change).trim(),
    'Keep everything else exactly as it is: the same woman (face, identity, hair, skin tone and expression), the same pose and body position, the same clothing and accessories (a requested clothing change keeps at least the same coverage), the same background, lighting, colours, framing and camera angle.',
    noTattooLine(body),
    noPiercingLine(body),
    REALISM_PHOTO,
    'Exactly one person.',
  );
}

export const NB_SYSTEM_PROMPT =
  'You are an expert image-generation engine for photorealistic social-media content. You must ALWAYS produce an image. ' +
  'Keep the identity of the reference person exactly (face, hair, skin tone) and her exact body shape and proportions — never slim her down or make her figure more average. Output looks like a real, candid smartphone photo.';

/**
 * Nano Banana prompt: model reference photos come first, the source frame is the LAST image.
 */
export function buildImagePrompt({ model, refCount, refDescription, analysis, instructions, hasSourceFrame, body, keepOutfit = true }) {
  const refs = refCount === 1 ? 'the first image' : `the first ${refCount} images`;
  const persona = model?.persona ? `Her look: ${model.persona}.` : '';
  const roles = refDescription ? `Reference photos — ${refDescription}.` : '';
  const scene = hasSourceFrame
    ? `Recreate the scene of the LAST image: same composition, camera angle and distance, framing, pose, body language, facial expression, background and lighting. Replace the person in it with the woman from the reference photos. Do not keep the original person's face, hair or identity. ${outfitText(keepOutfit, 'the person in the last image')}`
    : 'Place her in the scene described below.';
  return joinNonEmpty(
    `Create a photorealistic vertical 9:16 smartphone photo of the woman shown in ${refs} (reference photos). Keep her identity strictly: same face, facial features, hair, skin tone and body type. ${persona}`,
    roles,
    bodyLine(body),
    scene,
    analysis?.first_frame_prompt && `Scene details: ${analysis.first_frame_prompt}`,
    hasSourceFrame && keepOutfit !== 'asset' && PLAIN_CLOTHES,
    instructions && `Creative direction (priority): ${instructions}`,
    'Style: authentic amateur iPhone photo, natural light, realistic skin texture, slight grain, no beauty filter look. No text, captions, stickers, watermarks or UI elements. Exactly one person.',
  );
}

/** Opening words of every Wan prompt, matching the output ratio sent to the API. */
export function videoFormat(ratio = '9:16') {
  if (!ratio || ratio === '9:16') return 'Vertical 9:16 smartphone video';
  if (ratio === '1:1') return 'Square 1:1 smartphone video';
  const [w, h] = String(ratio).split(':').map(Number);
  return `${w > h ? 'Horizontal' : 'Vertical'} ${ratio} smartphone video`;
}

/** Wan 3.0 I2V: animate the approved first frame. */
export function buildVideoPromptI2V({ analysis, instructions, duration, body, ratio = '9:16' }) {
  const timeline = (analysis?.timeline || []).map((s) => `[${s.t}] ${s.action}`).join('\n');
  return joinNonEmpty(
    `${videoFormat(ratio)}${duration && duration !== 'auto' ? `, ${duration} seconds` : ''}, using the input image as the first frame. The woman in the image stays the same person the whole time (same face, hair and outfit).`,
    body && rulesLine(typeof body === 'object' ? body.rules : ''),
    noTattooLine(body),
    analysis?.video_prompt ? `Motion:\n${analysis.video_prompt}` : timeline ? `Motion:\n${timeline}` : 'Motion: natural, subtle, candid movement typical of an Instagram Reel; she looks at the camera and reacts naturally.',
    analysis?.camera && `Camera: ${analysis.camera}. Handheld phone feel, no cuts.`,
    analysis?.audio && `Audio design: ${analysis.audio}.`,
    instructions && `Creative direction (priority): ${instructions}`,
    `Negative constraints: no text, no subtitles, no watermark, no extra people, no face morphing, no identity drift, no distorted hands, no black frames${hasNoTattoos(body) ? ', no tattoos' : ''}.`,
  );
}

/** Wan 3.0 R2V: @Image1 = our model, @Video1 = source reel (motion only). */
export function buildVideoPromptR2V({ analysis, instructions, duration, hasFaceRef, body, ratio = '9:16' }) {
  return joinNonEmpty(
    `${videoFormat(ratio)}${duration && duration !== 'auto' ? `, ${duration} seconds` : ''}. The on-screen person is the woman in @Image1 — strictly keep her face, hair, body and outfit from @Image1.`,
    hasFaceRef && '@Image2 is a close-up of the same woman\'s face: use it to keep her facial identity sharp and consistent in every frame.',
    body && rulesLine(typeof body === 'object' ? body.rules : ''),
    noTattooLine(body),
    'Use @Video1 only as a motion and camera reference: reproduce its choreography, timing, gestures, framing and camera movement in the same kind of setting. Do not reproduce the person from @Video1 or her identity.',
    analysis?.summary && `What happens: ${analysis.summary}`,
    analysis?.setting && `Setting: ${analysis.setting}. Lighting: ${analysis.lighting || 'natural'}.`,
    analysis?.audio && `Audio design: ${analysis.audio}.`,
    instructions && `Creative direction (priority): ${instructions}`,
    `Negative constraints: no text, no subtitles, no watermark, no extra people, no face morphing, no identity drift${hasNoTattoos(body) ? ', no tattoos' : ''}.`,
  );
}

// ---- "remake de tudo" (motion transfer / video edit) ------------------------------------------

/** Kling Motion Control: the model photo performs the reel's motion. */
export function buildMotionPrompt({ instructions, body }) {
  return joinNonEmpty(
    body && bodyLine(body),
    'The woman from the reference image performs exactly the same movements, dance, gestures, hand motions, body language, facial expressions, lip movements and timing as the person in the reference video.',
    'Keep her face, hair, skin tone, body shape and outfit exactly as in the reference image. Same camera movement, framing and rhythm as the reference video.',
    'Photorealistic, natural skin texture, smartphone footage look. No text, no watermark, no extra people.',
    instructions && `Extra direction: ${instructions}`,
  );
}

/**
 * Video edit (Wan 2.7 / Kling Omni): replace only the person in the original reel.
 * `refs` like "image 1-2: her face; image 3: her body". Kling uses <<<video_1>>>/<<<image_N>>> tags.
 */
export function buildEditPrompt({ engine, refCount, keepOutfit = true, instructions, body }) {
  const kling = engine === 'kling_edit';
  const vid = kling ? '<<<video_1>>>' : 'the video';
  const imgs = kling
    ? Array.from({ length: refCount }, (_, i) => `<<<image_${i + 1}>>>`).join(', ')
    : refCount > 1 ? 'the reference images' : 'the reference image';
  return joinNonEmpty(
    `Replace the woman in ${vid} with the woman shown in ${imgs}: use exactly her face, facial features, hair, skin tone and body shape.`,
    bodyLine(body),
    `Keep EVERYTHING else identical to the original ${kling ? 'video' : 'video'}: every movement, gesture, dance step, facial expression, lip movement and timing, the camera motion, cuts and transitions, the background, props and lighting${keepOutfit ? ', and the original outfit' : ''}.`,
    'Photorealistic, consistent identity in every frame, no face morphing, no text, no watermark.',
    instructions && `Extra direction: ${instructions}`,
  );
}

// ---- photo posts ------------------------------------------------------------------------------

/** Pose library shown in the app (label PT, prompt EN). Neutral, social-media style poses. */
export const POSES = [
  { key: 'mirror_selfie', label: 'Mirror selfie', prompt: 'taking a mirror selfie with her phone held at chest height, relaxed stance, looking at the phone screen' },
  { key: 'front_selfie', label: 'Front selfie', prompt: 'holding the phone at arm\'s length taking a selfie, looking straight into the camera with a soft smile' },
  { key: 'standing_full', label: 'Standing, full body', prompt: 'standing full body facing the camera, weight on one leg, hands relaxed' },
  { key: 'over_shoulder', label: 'From behind, looking back', prompt: 'standing with her back to the camera, looking back over her shoulder at the camera' },
  { key: 'side_profile', label: 'Side profile', prompt: 'standing in side profile, face turned slightly towards the camera' },
  { key: 'sitting', label: 'Sitting', prompt: 'sitting casually (on a bed, sofa or chair that fits the scene), legs crossed, looking at the camera' },
  { key: 'lying_elbows', label: 'Lying down (on elbows)', prompt: 'lying on her stomach propped on her elbows, chin resting on her hands, looking at the camera' },
  { key: 'hand_hair', label: 'Hand in hair', prompt: 'one hand running through her hair, head slightly tilted, candid look' },
  { key: 'walking', label: 'Walking', prompt: 'walking towards the camera mid-step, natural candid movement' },
  { key: 'close_up', label: 'Face close-up', prompt: 'close-up portrait of her face and shoulders, looking into the camera' },
  { key: 'laughing', label: 'Laughing (candid)', prompt: 'laughing naturally, eyes slightly closed, candid moment' },
  { key: 'leaning_wall', label: 'Leaning on a wall', prompt: 'leaning her shoulder against a wall, arms crossed loosely, relaxed' },
  { key: 'squat', label: 'Crouching', prompt: 'crouching down casually, forearms on her knees, looking at the camera' },
  { key: 'stretch', label: 'Stretching', prompt: 'stretching both arms above her head, relaxed morning vibe' },
  { key: 'looking_away', label: 'Looking away', prompt: 'looking away from the camera towards a window or the side, candid, not posing' },
  { key: 'peace_sign', label: 'Peace sign', prompt: 'making a playful peace sign near her face, smiling at the camera' },
];

/** Remake of a photo post: model refs first, source photo last. */
export function buildPhotoRemakePrompt({ refCount, refDescription, persona, keepOutfit = true, instructions, body }) {
  const refs = refCount === 1 ? 'the first image' : `the first ${refCount} images`;
  return joinNonEmpty(
    `Recreate the LAST image as a new photo in which the person is the woman shown in ${refs} (reference photos). Keep her identity strictly: same face, facial features, hair, skin tone and body shape.${persona ? ` Her look: ${persona}.` : ''}`,
    refDescription && `Reference photos — ${refDescription}.`,
    bodyLine(body),
    keepOutfit && keepOutfit !== 'asset' && PLAIN_CLOTHES,
    `Copy the LAST image exactly: same pose, body position, hand placement, facial expression, camera angle, distance and framing, composition, background, props, lighting and colour grading${keepOutfit && keepOutfit !== 'asset' ? ', and the same outfit and accessories' : ''}. Do not keep the original person's face, hair or identity.${keepOutfit === 'asset' ? ' Her clothes come from the outfit reference image (see OUTFIT below), not from the LAST image.' : ''}`,
    instructions && `Extra direction (priority): ${instructions}`,
    'Photorealistic, looks like a real candid smartphone photo, natural skin texture, no beauty-filter look. No text, stickers, watermarks or UI. Exactly one person.',
  );
}

/** Same woman, same scene/outfit as the base image, new pose. */
export function buildPosePrompt({ pose, refDescription, persona, body }) {
  return joinNonEmpty(
    'The woman in all the images is the same person. Use the LAST image as the scene: same location, background, lighting, colour grading and the same outfit and hairstyle.',
    refDescription && `Identity references — ${refDescription}. Keep her face, hair, skin tone and body shape exactly.${persona ? ` Her look: ${persona}.` : ''}`,
    bodyLine(body),
    `New photo of her in this pose: ${pose}.`,
    'Photorealistic, looks like a real candid smartphone photo from the same photo shoot, natural skin texture. No text, no watermark, exactly one person.',
  );
}

/**
 * Wan 3.0 exact copy (R2V): @Image1 = AI model already placed in the reel's first frame,
 * @Image2 = her real face close-up, @Video1 = the original reel (motion, camera, scene).
 */
/** keepOutfit: true/'same' = same outfit as the source; 'covered' = similar but more covered; false/'model' = her own. */
export function outfitText(keepOutfit, who) {
  if (keepOutfit === 'asset') return `Do NOT use the outfit of ${who}: she wears her own outfit from the outfit reference image (see OUTFIT below).`;
  if (keepOutfit === 'covered') return `She wears an outfit similar in style and colours to ${who}, but more covered and casual: e.g. a light sheer cover-up, open beach shirt or sarong over it, or a one-piece instead of a bikini.`;
  if (keepOutfit === false || keepOutfit === 'model') return 'She wears a similar style of outfit of her own.';
  return `She wears the SAME outfit as ${who}: same garment types, colours, cut, fabric and details (as close as possible).`;
}

export function buildWan3CopyPrompt({ keepOutfit = true, instructions, body, seconds, hasFace = true, face2 = null, direct = false, ownPlace = false, outfitImage = null, outfitDesc = '', outfitClean = false, ratio = '9:16' }) {
  const own = keepOutfit === 'asset';
  const outfitSrc = direct
    ? (outfitImage ? `exactly the clothes shown in @Image${outfitImage}` : 'her own outfit')
    : `exactly the outfit she has on in @Image1${outfitImage ? ` (also shown in @Image${outfitImage}${outfitClean ? ', a product photo of the outfit — clothing only' : ' — use only its clothing'})` : ''}`;
  return joinNonEmpty(
    `${videoFormat(ratio)}, ${seconds ? `${seconds} seconds, ` : ''}an exact remake of @Video1 with a different woman.`,
    `The only person on screen is the woman from @Image1${hasFace ? ` (her face and identity exactly as in @Image2${face2 ? ` and @Image${face2}` : ''})` : ''}. She completely replaces the person of @Video1 — never show the original person's face or identity.`,
    `FACE (every frame, also in close-ups and while talking): her face always comes from ${hasFace ? `@Image2${face2 ? ` and @Image${face2}` : ''}` : '@Image1'} — her eyes, nose, lips, eyebrows, jawline, skin and freckles. From @Video1 take only the MOVEMENT (head turns, expressions, lip movement when she talks or sings), never the original person's face shape, lips, nose, makeup, skin, tattoos, piercings or jewelry.`,
    own && `OUTFIT (top priority, every frame): she wears ${outfitSrc}${outfitDesc ? ` — ${outfitDesc}` : ''}. The person in @Video1 wears DIFFERENT clothes: never copy the clothes of @Video1, not even for a single frame.`,
    `Copy @Video1 exactly${own ? ' (everything except the clothes)' : ''}: the same choreography, every movement, gesture, hand motion, hair touch, head turn, facial expression and their exact timing and rhythm; the same camera movement, framing, zoom and angles; the same cuts and transitions; ${ownPlace ? 'but the location is HER own room exactly as shown in @Image1 (not the background of @Video1).' : 'the same location, background, props and lighting.'}`,
    own
      ? ''
      : keepOutfit === 'covered'
      ? `She wears the more covered version of the @Video1 outfit${direct ? '' : ' shown in @Image1'} (similar style and colours).`
      : keepOutfit
        ? `She wears the same outfit as in @Video1 (same garment types, colours, cut and details; very close if not identical)${direct ? '' : ', exactly as shown in @Image1'}. ${PLAIN_CLOTHES}`
        : 'She wears the outfit shown in @Image1.',
    bodyLine(body),
    instructions && `Extra direction: ${instructions}`,
    REALISM_VIDEO,
    `Consistent identity in every frame. No text, no subtitles, no watermark, no extra people, no face morphing${hasNoTattoos(body) ? ', no tattoos' : ''}.`,
  );
}
