import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { getDb } from '../db/mongodb';

export interface CompanyVerificationDoc {
  _id: string; // Sanitized input name in uppercase (e.g., "TCS" or "TATA_CONSULTANCY")
  canonicalName: string; // Normalized name (e.g., "Tata_Consultancy_Services")
  displayName: string; // Human-friendly name (e.g., "Tata Consultancy Services")
  status: 'registered' | 'unregistered';
  rank: 'A' | 'B' | 'unranked';
  justification: string;
  verifiedAt: Date;
}

// Local fallback database for common normalizations when Gemini API key is missing or fails
const LOCAL_FALLBACKS: Record<string, { canonicalName: string; displayName: string; status: 'registered' | 'unregistered'; rank: 'A' | 'B' | 'unranked'; justification: string }> = {
  'TCS': {
    canonicalName: 'Tata_Consultancy_Services',
    displayName: 'Tata Consultancy Services',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'TATA_CONSULTANCY': {
    canonicalName: 'Tata_Consultancy_Services',
    displayName: 'Tata Consultancy Services',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'TATA_CONSULTANCY_SERVICES': {
    canonicalName: 'Tata_Consultancy_Services',
    displayName: 'Tata Consultancy Services',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'GOOGLE': {
    canonicalName: 'Google',
    displayName: 'Google',
    status: 'registered',
    rank: 'A',
    justification: 'Global technology giant.'
  },
  'MICROSOFT': {
    canonicalName: 'Microsoft',
    displayName: 'Microsoft',
    status: 'registered',
    rank: 'A',
    justification: 'Global technology giant.'
  },
  'MS': {
    canonicalName: 'Microsoft',
    displayName: 'Microsoft',
    status: 'registered',
    rank: 'A',
    justification: 'Global technology giant.'
  },
  'AMAZON': {
    canonicalName: 'Amazon',
    displayName: 'Amazon',
    status: 'registered',
    rank: 'A',
    justification: 'Global e-commerce and cloud giant.'
  },
  'AWS': {
    canonicalName: 'Amazon_Web_Services',
    displayName: 'Amazon Web Services',
    status: 'registered',
    rank: 'A',
    justification: 'Cloud computing subsidiary of Amazon.'
  },
  'META': {
    canonicalName: 'Meta',
    displayName: 'Meta',
    status: 'registered',
    rank: 'A',
    justification: 'Global social media and technology giant.'
  },
  'FACEBOOK': {
    canonicalName: 'Meta',
    displayName: 'Meta',
    status: 'registered',
    rank: 'A',
    justification: 'Global social media and technology giant (formerly Facebook).'
  },
  'INFOSYS': {
    canonicalName: 'Infosys',
    displayName: 'Infosys',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'HP': {
    canonicalName: 'Hewlett_Packard',
    displayName: 'Hewlett Packard',
    status: 'registered',
    rank: 'A',
    justification: 'Global technology company, Fortune 500.'
  },
  'HPE': {
    canonicalName: 'Hewlett_Packard_Enterprise',
    displayName: 'Hewlett Packard Enterprise',
    status: 'registered',
    rank: 'A',
    justification: 'Enterprise IT company, spun off from HP.'
  },
  'HEWLETT_PACKARD': {
    canonicalName: 'Hewlett_Packard',
    displayName: 'Hewlett Packard',
    status: 'registered',
    rank: 'A',
    justification: 'Global technology company, Fortune 500.'
  },
  'HEWLETT_PACKARD_ENTERPRISE': {
    canonicalName: 'Hewlett_Packard_Enterprise',
    displayName: 'Hewlett Packard Enterprise',
    status: 'registered',
    rank: 'A',
    justification: 'Enterprise IT company, spun off from HP.'
  },
  'GOLDMAN_SACHS': {
    canonicalName: 'Goldman_Sachs',
    displayName: 'Goldman Sachs',
    status: 'registered',
    rank: 'A',
    justification: 'Global investment banking giant.'
  },
  'GS': {
    canonicalName: 'Goldman_Sachs',
    displayName: 'Goldman Sachs',
    status: 'registered',
    rank: 'A',
    justification: 'Global investment banking giant.'
  },
  'JPMORGAN_CHASE': {
    canonicalName: 'JPMorgan_Chase',
    displayName: 'JPMorgan Chase',
    status: 'registered',
    rank: 'A',
    justification: 'Global banking and financial services giant.'
  },
  'JPM': {
    canonicalName: 'JPMorgan_Chase',
    displayName: 'JPMorgan Chase',
    status: 'registered',
    rank: 'A',
    justification: 'Global banking and financial services giant.'
  },
  'ACCENTURE': {
    canonicalName: 'Accenture',
    displayName: 'Accenture',
    status: 'registered',
    rank: 'A',
    justification: 'Global consulting and professional services.'
  },
  'WIPRO': {
    canonicalName: 'Wipro',
    displayName: 'Wipro',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'HCL': {
    canonicalName: 'HCL_Technologies',
    displayName: 'HCL Technologies',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'HCL_TECHNOLOGIES': {
    canonicalName: 'HCL_Technologies',
    displayName: 'HCL Technologies',
    status: 'registered',
    rank: 'A',
    justification: 'National enterprise, major Indian IT services provider.'
  },
  'COGNIZANT': {
    canonicalName: 'Cognizant',
    displayName: 'Cognizant',
    status: 'registered',
    rank: 'A',
    justification: 'Major IT services and consulting company.'
  },
  'CTS': {
    canonicalName: 'Cognizant',
    displayName: 'Cognizant',
    status: 'registered',
    rank: 'A',
    justification: 'Major IT services and consulting company.'
  },
  'DELOITTE': {
    canonicalName: 'Deloitte',
    displayName: 'Deloitte',
    status: 'registered',
    rank: 'A',
    justification: 'Big Four consulting and professional services.'
  },
  'FLIPKART': {
    canonicalName: 'Flipkart',
    displayName: 'Flipkart',
    status: 'registered',
    rank: 'B',
    justification: 'Major Indian e-commerce company, Walmart subsidiary.'
  },
  'RAZORPAY': {
    canonicalName: 'Razorpay',
    displayName: 'Razorpay',
    status: 'registered',
    rank: 'B',
    justification: 'Well-funded Indian fintech startup.'
  },
  'ZOMATO': {
    canonicalName: 'Zomato',
    displayName: 'Zomato',
    status: 'registered',
    rank: 'B',
    justification: 'Publicly listed Indian food-tech company.'
  },
  'SWIGGY': {
    canonicalName: 'Swiggy',
    displayName: 'Swiggy',
    status: 'registered',
    rank: 'B',
    justification: 'Major Indian food delivery startup.'
  },
  'STUDENT': {
    canonicalName: 'Student',
    displayName: 'Student',
    status: 'unregistered',
    rank: 'unranked',
    justification: 'Academic profile registration.'
  },
  'UNEMPLOYED': {
    canonicalName: 'Unemployed',
    displayName: 'Unemployed',
    status: 'unregistered',
    rank: 'unranked',
    justification: 'Profile registered under Unemployed.'
  }
};

/**
 * Standardizes raw input to an uppercase lookup key.
 */
function toLookupKey(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '_');
}

/**
 * Normalizes a company name using local fallback rules.
 */
function resolveLocalFallback(rawName: string): Omit<CompanyVerificationDoc, '_id' | 'verifiedAt'> {
  const key = toLookupKey(rawName);
  if (LOCAL_FALLBACKS[key]) {
    return LOCAL_FALLBACKS[key];
  }

  // Generic formatting fallback
  const cleanName = rawName
    .trim()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('_');

  const cleanDisplayName = cleanName.replace(/_/g, ' ');

  // Student/Unemployed checks
  const lower = rawName.toLowerCase();
  if (lower.includes('student')) {
    return {
      canonicalName: 'Student',
      displayName: 'Student',
      status: 'unregistered',
      rank: 'unranked',
      justification: 'Identified as student profile.'
    };
  }
  if (lower.includes('unemployed')) {
    return {
      canonicalName: 'Unemployed',
      displayName: 'Unemployed',
      status: 'unregistered',
      rank: 'unranked',
      justification: 'Identified as unemployed profile.'
    };
  }

  return {
    canonicalName: cleanName,
    displayName: cleanDisplayName,
    status: 'unregistered',
    rank: 'unranked',
    justification: 'Local fallback formatting applied; unregistered entity.'
  };
}

/**
 * Verifies and normalizes a company name using Gemini API with structured JSON output.
 * Falls back to local formatting / heuristics if the API fails or key is missing.
 */
export async function verifyAndNormalizeCompany(companyName: string): Promise<CompanyVerificationDoc> {
  const db = getDb();
  const verificationsCol = db.collection<CompanyVerificationDoc>('company_verifications');
  const lookupKey = toLookupKey(companyName);

  // 1. Check database cache first (by raw lookup key or matching canonicalName)
  const cached = await verificationsCol.findOne({
    $or: [
      { _id: lookupKey },
      { canonicalName: companyName },
      { canonicalName: companyName.replace(/_/g, ' ') },
      { canonicalName: companyName.replace(/\s+/g, '_') }
    ]
  } as any);
  if (cached) {
    console.log(`[Verifier] Cache HIT for: "${companyName}" -> ${cached.canonicalName} (${cached.rank})`);
    return cached;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  let resolved: Omit<CompanyVerificationDoc, '_id' | 'verifiedAt'>;

  if (!apiKey) {
    console.warn(`[Verifier] GEMINI_API_KEY not found in environment. Using local fallback rules.`);
    resolved = resolveLocalFallback(companyName);
  } else {
    // Try multiple models with fallback and retry logic
    const modelsToTry = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
    const MAX_RETRIES_PER_MODEL = 2;
    let responseText = '';
    let lastError: any = null;

    const genAI = new GoogleGenerativeAI(apiKey);

    modelLoop: for (const modelName of modelsToTry) {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              canonicalName: {
                type: SchemaType.STRING,
                description: 'The standardized canonical name of the company in Title_Case_With_Underscores. Examples: "Tata_Consultancy_Services" for TCS or Tata Consultancy, "Google" for Google, "Razorpay" for Razorpay, "Student" for students, "Unemployed" for unemployed.',
              },
              displayName: {
                type: SchemaType.STRING,
                description: 'Human-readable, properly capitalized company name (e.g. "Tata Consultancy Services" or "Google").',
              },
              status: {
                type: SchemaType.STRING,
                enum: ['registered', 'unregistered'],
                description: 'Whether this is a real, officially registered company or organization. Select "unregistered" for invalid inputs, test/fake companies, students, or unemployed registrations.',
              },
              rank: {
                type: SchemaType.STRING,
                enum: ['A', 'B', 'unranked'],
                description: 'Rank: A = Large global or national enterprises (TCS, Google, Microsoft, Infosys, Amazon, Accenture). B = Well-known mid-sized companies, funded startups (Cred, Razorpay, Zomato, Swiggy). unranked = small local startups, personal test names, student, or unemployed.',
              },
              justification: {
                type: SchemaType.STRING,
                description: 'One sentence explaining why it was categorized this way.',
              },
            },
            required: ['canonicalName', 'displayName', 'status', 'rank', 'justification'],
          } as any,
        },
      });

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
        try {
          console.log(`[Verifier] Querying model ${modelName} for "${companyName}" (attempt ${attempt}/${MAX_RETRIES_PER_MODEL})...`);
          const prompt = `Analyze, normalize, and verify the company input.
Input raw company name: "${companyName}"`;

          const response = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            systemInstruction: `You are an expert corporate registry verifier and deduplication agent. Normalize raw company names (e.g. "TCS", "tata consultancy" -> "Tata_Consultancy_Services"). Categorize them as Rank A (Fortune 500, major MNCs, national giants), Rank B (funded startups, established mid-size companies), or unranked (small startups, test entries, students, unemployed). Ensure canonicalName uses Title_Case_With_Underscores.`,
          });

          responseText = response.response.text();
          console.log(`[Verifier] Success with model: ${modelName}`);
          break modelLoop;
        } catch (apiErr: any) {
          lastError = apiErr;
          const status = apiErr?.status || apiErr?.response?.status;
          const errMsg = apiErr?.message || '';
          const isRetryable = status === 503 || status === 429 || 
                              errMsg.includes('503') || errMsg.includes('429') || 
                              errMsg.includes('Service Unavailable') || errMsg.includes('high demand');

          if (isRetryable && attempt < MAX_RETRIES_PER_MODEL) {
            const backoffMs = 2000 * Math.pow(2, attempt - 1); // 2s
            console.warn(`[Verifier] Model ${modelName} returned retryable error (status: ${status || 'unknown'}, msg: ${errMsg}), retrying in ${backoffMs / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          } else {
            console.warn(`[Verifier] Model ${modelName} failed on attempt ${attempt}. Error: ${errMsg}`);
            break; // Try next model
          }
        }
      }
    }

    if (!responseText) {
      console.error(`[Verifier] All Gemini models failed to verify "${companyName}". Falling back to local rules.`);
      resolved = resolveLocalFallback(companyName);
    } else {
      try {
        const parsed = JSON.parse(responseText);
        const sanitizedCanonical = parsed.canonicalName.trim().replace(/[\s]+/g, '_');

        resolved = {
          canonicalName: sanitizedCanonical,
          displayName: parsed.displayName,
          status: parsed.status,
          rank: parsed.rank,
          justification: parsed.justification,
        };
      } catch (err) {
        console.error(`[Verifier] Gemini verification JSON parse failed for "${companyName}". Falling back to local:`, err);
        resolved = resolveLocalFallback(companyName);
      }
    }
  }

  // 2. Cache result in MongoDB
  const verificationResult: CompanyVerificationDoc = {
    _id: lookupKey,
    ...resolved,
    verifiedAt: new Date()
  };

  try {
    await verificationsCol.updateOne(
      { _id: lookupKey },
      { $set: verificationResult },
      { upsert: true }
    );
    console.log(`[Verifier] Cached result for "${companyName}" -> ${verificationResult.canonicalName}`);
  } catch (dbErr) {
    console.error(`[Verifier] Failed to cache verification for "${companyName}":`, dbErr);
  }

  return verificationResult;
}

/**
 * Normalizes all company names currently in the database to their canonical values.
 * Uses a SINGLE batch Gemini API call for all uncached companies to avoid rate limits.
 * Cached companies are skipped (no API call needed).
 */
export async function runDatabaseCompanyNormalization(): Promise<{ checked: number; updatedReferrals: number; apiCalls: number }> {
  const db = getDb();
  const referralsCollection = db.collection('referrals');
  const verificationsCol = db.collection<CompanyVerificationDoc>('company_verifications');

  // 1. Fetch all distinct company values currently in the referrals collection
  const rawCompanies: string[] = await referralsCollection.distinct('company', { deletedAt: { $exists: false } });
  
  let checked = rawCompanies.length;
  let updatedReferrals = 0;
  let apiCalls = 0;

  // 2. Separate into cached and uncached companies
  const uncachedNames: string[] = [];
  const cachedResults: Map<string, CompanyVerificationDoc> = new Map();

  for (const rawName of rawCompanies) {
    const lookupKey = toLookupKey(rawName);
    const cached = await verificationsCol.findOne({
      $or: [
        { _id: lookupKey },
        { canonicalName: rawName },
        { canonicalName: rawName.replace(/_/g, ' ') },
        { canonicalName: rawName.replace(/\s+/g, '_') }
      ]
    } as any);
    if (cached) {
      console.log(`[Verifier] Cache HIT for: "${rawName}" -> ${cached.canonicalName} (${cached.rank})`);
      cachedResults.set(rawName, cached);
    } else {
      uncachedNames.push(rawName);
    }
  }

  console.log(`[Normalization] ${cachedResults.size} cached, ${uncachedNames.length} uncached companies to verify.`);

  // 3. If there are uncached companies, batch-verify them in ONE Gemini API call
  if (uncachedNames.length > 0) {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.warn(`[Verifier] GEMINI_API_KEY not found. Using local fallback for ${uncachedNames.length} companies.`);
      for (const rawName of uncachedNames) {
        const resolved = resolveLocalFallback(rawName);
        const lookupKey = toLookupKey(rawName);
        const doc: CompanyVerificationDoc = { _id: lookupKey, ...resolved, verifiedAt: new Date() };
        try {
          await verificationsCol.updateOne({ _id: lookupKey }, { $set: doc }, { upsert: true });
          console.log(`[Verifier] Cached (fallback) "${rawName}" -> ${doc.canonicalName}`);
        } catch (dbErr) {
          console.error(`[Verifier] Failed to cache fallback for "${rawName}":`, dbErr);
        }
        cachedResults.set(rawName, doc);
      }
    } else {
      const modelsToTry = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
      const MAX_RETRIES_PER_MODEL = 2;
      let success = false;
      let lastError: any = null;

      modelLoop: for (const modelName of modelsToTry) {
        let attempt = 0;
        while (attempt < MAX_RETRIES_PER_MODEL) {
          try {
            attempt++;
            console.log(`[Verifier] Batch querying Gemini for ${uncachedNames.length} companies using ${modelName} (attempt ${attempt}/${MAX_RETRIES_PER_MODEL})...`);
            apiCalls++;

            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({
              model: modelName,
              generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: SchemaType.OBJECT,
                  properties: {
                    companies: {
                      type: SchemaType.ARRAY,
                      items: {
                        type: SchemaType.OBJECT,
                        properties: {
                          inputName: {
                            type: SchemaType.STRING,
                            description: 'The exact input company name from the list (unchanged).',
                          },
                          canonicalName: {
                            type: SchemaType.STRING,
                            description: 'Standardized canonical name in Title_Case_With_Underscores. e.g. "Tata_Consultancy_Services" for TCS, "Google" for Google.',
                          },
                          displayName: {
                            type: SchemaType.STRING,
                            description: 'Human-readable properly capitalized name. e.g. "Tata Consultancy Services".',
                          },
                          status: {
                            type: SchemaType.STRING,
                            enum: ['registered', 'unregistered'],
                            description: 'Whether this is a real, officially registered company. "unregistered" for fake/test names, students, or unemployed.',
                          },
                          rank: {
                            type: SchemaType.STRING,
                            enum: ['A', 'B', 'unranked'],
                            description: 'A = Fortune 500, global/national enterprises. B = funded startups, established mid-size. unranked = small/unknown/student/unemployed.',
                          },
                          justification: {
                            type: SchemaType.STRING,
                            description: 'One sentence explaining the categorization.',
                          },
                        },
                        required: ['inputName', 'canonicalName', 'displayName', 'status', 'rank', 'justification'],
                      },
                    },
                  },
                  required: ['companies'],
                } as any,
              },
            });

            const companyList = uncachedNames.map((name, i) => `${i + 1}. "${name}"`).join('\n');

            const prompt = `Analyze, normalize, verify, and rank ALL of the following ${uncachedNames.length} company names. Return a result for each one.\n\nCompany list:\n${companyList}`;

            const response = await model.generateContent({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              systemInstruction: `You are an expert corporate registry verifier and deduplication agent. You will receive a batch of raw company names. For EACH name, normalize it (e.g. "TCS", "tata consultancy" -> "Tata_Consultancy_Services"), determine if it's a real registered company, and rank it:
- Rank A: Fortune 500, major MNCs, national giants (TCS, Google, Microsoft, Infosys, Amazon, Accenture, Wipro, Oracle, Salesforce, etc.)
- Rank B: Well-known funded startups, established mid-size companies (Cred, Razorpay, Zomato, Swiggy, Sprinklr, etc.)
- unranked: Small local startups, unknown entities, personal/test names, students, unemployed

Rules:
- canonicalName must use Title_Case_With_Underscores format
- Deduplicate abbreviations to their full canonical form
- "Student", "Unemployed" = status: unregistered, rank: unranked
- Return the inputName EXACTLY as provided (do not modify it)
- Return one entry for EACH input company name`,
            });

            const responseText = response.response.text();
            const parsed = JSON.parse(responseText);
            const batchResults: Array<{ inputName: string; canonicalName: string; displayName: string; status: string; rank: string; justification: string }> = parsed.companies || [];

            console.log(`[Verifier] Gemini returned ${batchResults.length} results for ${uncachedNames.length} companies.`);

            // Build a lookup map from inputName -> result
            const resultMap = new Map<string, typeof batchResults[0]>();
            for (const r of batchResults) {
              resultMap.set(r.inputName, r);
            }

            // Cache each result
            for (const rawName of uncachedNames) {
              const geminiResult = resultMap.get(rawName);
              const lookupKey = toLookupKey(rawName);
              let doc: CompanyVerificationDoc;

              if (geminiResult) {
                const sanitizedCanonical = geminiResult.canonicalName.trim().replace(/[\s]+/g, '_');
                doc = {
                  _id: lookupKey,
                  canonicalName: sanitizedCanonical,
                  displayName: geminiResult.displayName,
                  status: geminiResult.status as 'registered' | 'unregistered',
                  rank: geminiResult.rank as 'A' | 'B' | 'unranked',
                  justification: geminiResult.justification,
                  verifiedAt: new Date(),
                };
              } else {
                // Gemini didn't return this one — use local fallback
                console.warn(`[Verifier] Gemini batch missed "${rawName}". Using local fallback.`);
                const resolved = resolveLocalFallback(rawName);
                doc = { _id: lookupKey, ...resolved, verifiedAt: new Date() };
              }

              try {
                await verificationsCol.updateOne({ _id: lookupKey }, { $set: doc }, { upsert: true });
                console.log(`[Verifier] Cached "${rawName}" -> ${doc.canonicalName} (${doc.rank})`);
              } catch (dbErr) {
                console.error(`[Verifier] Failed to cache "${rawName}":`, dbErr);
              }
              cachedResults.set(rawName, doc);
            }
            success = true;
            break modelLoop; // Success! Exit both loops.
          } catch (err: any) {
            lastError = err;
            const status = err?.status || err?.response?.status;
            const errMsg = err?.message || '';
            const is429 = status === 429 || errMsg.includes('429');
            const is503 = status === 503 || errMsg.includes('503') || errMsg.includes('Service Unavailable') || errMsg.includes('high demand');

            if (is429 && attempt < MAX_RETRIES_PER_MODEL) {
              // Extract retry delay from error response (default 60s)
              let waitSeconds = 60;
              if (err?.errorDetails) {
                for (const detail of err.errorDetails) {
                  if (detail['@type']?.includes('RetryInfo') && detail.retryDelay) {
                    const parsed = parseInt(detail.retryDelay);
                    if (!isNaN(parsed)) waitSeconds = parsed + 5; // Add 5s buffer
                  }
                }
              }
              console.warn(`[Verifier] Rate limited (429). Waiting ${waitSeconds}s before retry ${attempt + 1}/${MAX_RETRIES_PER_MODEL}...`);
              await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
            } else if (is503 && attempt < MAX_RETRIES_PER_MODEL) {
              const waitSeconds = 5;
              console.warn(`[Verifier] Service unavailable (503). Waiting ${waitSeconds}s before retry ${attempt + 1}/${MAX_RETRIES_PER_MODEL}...`);
              await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
            } else {
              // Non-retryable error OR retries exhausted for this model.
              console.warn(`[Verifier] Model ${modelName} failed on attempt ${attempt}. Error: ${errMsg}. Trying next model...`);
              break; // Break the attempt loop to try next model in modelLoop
            }
          }
        }
      }

      if (!success) {
        const reason = lastError?.status === 429
          ? `Rate limit quota exhausted.`
          : `Gemini API error: ${lastError?.message || lastError}`;
        console.error(`[Verifier] Batch verification FAILED for all models: ${reason}`);
        console.error(`[Verifier] ${uncachedNames.length} companies remain UNVERIFIED. They will be retried on next run.`);
      }
    }
  }

  // 4. Now apply normalization: update referrals with canonical names
  for (const rawName of rawCompanies) {
    const verification = cachedResults.get(rawName);
    if (!verification) continue;

    const canonical = verification.canonicalName;
    if (rawName !== canonical) {
      try {
        const result = await referralsCollection.updateMany(
          { company: rawName, deletedAt: { $exists: false } },
          { $set: { company: canonical, updatedAt: new Date() } }
        );
        updatedReferrals += result.modifiedCount;
        if (result.modifiedCount > 0) {
          console.log(`[Normalization] Standardized "${rawName}" -> "${canonical}" (updated ${result.modifiedCount} referrals)`);
        }
      } catch (err) {
        console.error(`[Normalization] Failed to normalize "${rawName}":`, err);
      }
    }
  }

  return { checked, updatedReferrals, apiCalls };
}

/**
 * Flushes stale/fallback-cached verification entries from the database.
 * Deletes ALL entries with rank='unranked' so they can be re-verified by Gemini
 * on the next normalization run (excludes Student and Unemployed which are legitimately unranked).
 * Returns the number of deleted entries.
 */
export async function flushStaleVerifications(): Promise<number> {
  const db = getDb();
  const verificationsCol = db.collection<CompanyVerificationDoc>('company_verifications');

  // Delete all unranked entries EXCEPT Student and Unemployed (those are legitimately unranked)
  const result = await verificationsCol.deleteMany({
    rank: 'unranked',
    canonicalName: { $nin: ['Student', 'Unemployed'] }
  });

  console.log(`[Verifier] Flushed ${result.deletedCount} stale/unranked verification entries.`);
  return result.deletedCount;
}

