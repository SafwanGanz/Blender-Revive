import { getDb } from '../db/mongodb';
import { getLevenshteinDistance } from '../commands';

/**
 * Represents a referral record (only the fields we care about for company resolution).
 */
export interface MinimalReferralDoc {
  _id: string;
  company: string;
  username: string;
  phoneJid?: string;
  deletedAt?: Date;
}

/**
 * Comprehensive alias map for common company abbreviations, nicknames, and alternate names.
 * Keys are UPPERCASE. Values are the canonical underscore-separated names that the bot stores internally.
 * When a user searches with any key, it resolves to the value before hitting the DB.
 */
const COMPANY_ALIASES: Record<string, string[]> = {
  // Tech Giants
  'HP': ['Hewlett_Packard', 'Hewlett_Packard_Enterprise', 'HP_Inc'],
  'HPE': ['Hewlett_Packard_Enterprise'],
  'HEWLETT': ['Hewlett_Packard', 'Hewlett_Packard_Enterprise'],
  'HEWLETT_PACKARD': ['Hewlett_Packard', 'Hewlett_Packard_Enterprise'],
  'HEWLET_PACKING': ['Hewlett_Packard', 'Hewlett_Packard_Enterprise'],
  'HEWLET_PACKARD': ['Hewlett_Packard', 'Hewlett_Packard_Enterprise'],
  'HEWLETT_PACKING': ['Hewlett_Packard', 'Hewlett_Packard_Enterprise'],
  'MS': ['Microsoft'],
  'MSFT': ['Microsoft'],
  'GOOG': ['Google'],
  'AMZN': ['Amazon'],
  'AWS': ['Amazon_Web_Services', 'Amazon'],
  'FB': ['Meta'],
  'FACEBOOK': ['Meta'],
  'INSTA': ['Meta'],
  'INSTAGRAM': ['Meta'],
  'WHATSAPP': ['Meta'],
  'AAPL': ['Apple'],

  // Indian IT Giants
  'TCS': ['Tata_Consultancy_Services'],
  'TATA': ['Tata_Consultancy_Services'],
  'TATA_CONSULTANCY': ['Tata_Consultancy_Services'],
  'INFY': ['Infosys'],
  'WIPRO': ['Wipro'],
  'HCL': ['HCL_Technologies'],
  'HCLTECH': ['HCL_Technologies'],
  'TECHM': ['Tech_Mahindra'],
  'TECH_M': ['Tech_Mahindra'],
  'LTI': ['LTI_Mindtree', 'LTIMindtree'],
  'LTIM': ['LTI_Mindtree', 'LTIMindtree'],
  'LTIMINDTREE': ['LTI_Mindtree', 'LTIMindtree'],
  'MINDTREE': ['LTI_Mindtree', 'LTIMindtree'],
  'MPHASIS': ['Mphasis'],
  'COFORGE': ['Coforge'],
  'NIIT': ['NIIT_Technologies'],
  'PERSISTENT': ['Persistent_Systems'],

  // Consulting & Finance
  'GS': ['Goldman_Sachs'],
  'GOLDMAN': ['Goldman_Sachs'],
  'JPM': ['JPMorgan_Chase'],
  'JPMORGAN': ['JPMorgan_Chase'],
  'JP_MORGAN': ['JPMorgan_Chase'],
  'MS_FINANCE': ['Morgan_Stanley'],
  'MORGAN_STANLEY': ['Morgan_Stanley'],
  'DB': ['Deutsche_Bank'],
  'DEUTSCHE': ['Deutsche_Bank'],
  'BOFA': ['Bank_Of_America'],
  'BOA': ['Bank_Of_America'],
  'BANK_OF_AMERICA': ['Bank_Of_America'],
  'CITI': ['Citibank', 'Citi'],
  'CITIBANK': ['Citibank', 'Citi'],
  'BARCLAYS': ['Barclays'],
  'HSBC': ['HSBC'],
  'UBS': ['UBS'],
  'DELOITTE': ['Deloitte'],
  'PWC': ['PricewaterhouseCoopers'],
  'PRICEWATERHOUSE': ['PricewaterhouseCoopers'],
  'EY': ['Ernst_And_Young'],
  'ERNST_YOUNG': ['Ernst_And_Young'],
  'KPMG': ['KPMG'],
  'MCKINSEY': ['McKinsey'],
  'BCG': ['Boston_Consulting_Group'],
  'BAIN': ['Bain_And_Company'],
  'BDO': ['BDO_India'],
  'BDO_INDIA': ['BDO_India'],

  // Product & Startups
  'CRM': ['Salesforce'],
  'SFDC': ['Salesforce'],
  'ORCL': ['Oracle'],
  'SAP': ['SAP'],
  'IBM': ['IBM'],
  'CISCO': ['Cisco'],
  'INTC': ['Intel'],
  'INTEL': ['Intel'],
  'AMD': ['AMD'],
  'NVDA': ['Nvidia'],
  'NVIDIA': ['Nvidia'],
  'UBER': ['Uber'],
  'OLA': ['Ola'],
  'ZOMATO': ['Zomato'],
  'SWIGGY': ['Swiggy'],
  'CRED': ['Cred'],
  'RPay': ['Razorpay'],
  'RAZORPAY': ['Razorpay'],
  'PAYTM': ['Paytm'],
  'PHONEPE': ['PhonePe'],
  'PHONE_PE': ['PhonePe'],
  'FLIPKART': ['Flipkart'],
  'FK': ['Flipkart'],
  'MEESHO': ['Meesho'],
  'BYJU': ['Byjus'],
  'BYJUS': ['Byjus'],
  'ZERODHA': ['Zerodha'],
  'GROWW': ['Groww'],
  'DUNZO': ['Dunzo'],
  'DREAM11': ['Dream11'],
  'D11': ['Dream11'],
  'JUSPAY': ['Juspay'],
  'SPRINKLR': ['Sprinklr'],
  'FRESHWORKS': ['Freshworks'],
  'ZOHO': ['Zoho'],
  'ATLASSIAN': ['Atlassian'],
  'ADOBE': ['Adobe'],
  'VMWARE': ['VMware'],
  'BROADCOM': ['Broadcom'],
  'DELL': ['Dell_Technologies'],
  'QUALCOMM': ['Qualcomm'],
  'SAMSUNG': ['Samsung'],
  'SONY': ['Sony'],
  'LG': ['LG_Electronics'],
  'ACCENTURE': ['Accenture'],
  'CAPGEMINI': ['Capgemini'],
  'COGNIZANT': ['Cognizant'],
  'CTS': ['Cognizant'],
};

/**
 * Sanitizes a company name by capitalizing the first letter of each word and replacing spaces with underscores.
 */
export function sanitizeCompanyName(name: string): string {
  if (!name) return '';
  return name
    .trim()
    .split(/[_\s]+/) // Split by spaces or underscores
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('_');
}

/**
 * Escapes special regex characters in a string.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves a company name by checking for exact matches, substring matches, or close typos in the database.
 * If a match is found, returns the matched company name and a boolean indicating if it was a suggestion.
 * If no match is found, returns the sanitized input.
 */
export async function resolveCompanySanity(rawName: string): Promise<{ matched: string; isSuggested: boolean }> {
  const sanitized = sanitizeCompanyName(rawName);
  if (!sanitized) return { matched: '', isSuggested: false };

  const referralsCollection = getDb().collection<MinimalReferralDoc>('referrals');

  // 0. Alias lookup — resolve abbreviations (HP, TCS, GS, etc.) BEFORE any DB queries
  const aliasKey = sanitized.toUpperCase().replace(/[_\s]+/g, '_');
  const aliasCandidates = COMPANY_ALIASES[aliasKey];
  if (aliasCandidates && aliasCandidates.length > 0) {
    // Try each alias candidate against the DB — return the first that has registered users
    // Also try space/underscore variants since DB entries may store either form
    for (const candidate of aliasCandidates) {
      const candidateSpace = candidate.replace(/_/g, ' ');
      const candidateUnderscore = candidate.replace(/\s+/g, '_');
      const aliasMatch = await referralsCollection.findOne({
        $or: [
          { company: { $regex: new RegExp(`^${escapeRegex(candidate)}$`, 'i') } },
          { company: { $regex: new RegExp(`^${escapeRegex(candidateSpace)}$`, 'i') } },
          { company: { $regex: new RegExp(`^${escapeRegex(candidateUnderscore)}$`, 'i') } }
        ],
        deletedAt: { $exists: false }
      } as any);
      if (aliasMatch) {
        console.log(`[Resolver] Alias HIT: "${rawName}" → "${aliasMatch.company}" (via alias key "${aliasKey}")`);
        return { matched: aliasMatch.company, isSuggested: true };
      }
    }
    // No alias candidate found in DB — fall through to the first candidate as a best guess
    console.log(`[Resolver] Alias partial: "${rawName}" → "${aliasCandidates[0]}" (no DB match, using first candidate)`);
    return { matched: aliasCandidates[0], isSuggested: true };
  }

  // 1. Check exact/case-insensitive match (not soft-deleted)
  const exactMatch = await referralsCollection.findOne({
    company: { $regex: new RegExp(`^${escapeRegex(sanitized)}$`, 'i') },
    deletedAt: { $exists: false }
  } as any);

  if (exactMatch) {
    return { matched: exactMatch.company, isSuggested: false };
  }

  // Get all unique companies (not soft-deleted)
  const allCompanies = await referralsCollection.distinct('company', { deletedAt: { $exists: false } });
  if (allCompanies.length === 0) {
    return { matched: sanitized, isSuggested: false };
  }

  // 2. Try substring matching
  const substringMatches = allCompanies.filter((c) =>
    c.toLowerCase().includes(sanitized.toLowerCase())
  );

  if (substringMatches.length > 0) {
    substringMatches.sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(sanitized.toLowerCase());
      const bStarts = b.toLowerCase().startsWith(sanitized.toLowerCase());
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.length - b.length;
    });
    return { matched: substringMatches[0], isSuggested: true };
  }

  // 2.5 Word-boundary matching — handles mangled names like "hewlet packing" → "Hewlett_Packard"
  // Split both the input and each company name into words and check overlap
  const inputWords = sanitized.toLowerCase().replace(/_/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  if (inputWords.length > 0) {
    let bestWordMatch: string | null = null;
    let bestWordScore = 0;

    for (const company of allCompanies) {
      const companyWords = company.toLowerCase().replace(/_/g, ' ').split(/\s+/).filter(w => w.length >= 2);
      let matchScore = 0;

      for (const inputWord of inputWords) {
        for (const companyWord of companyWords) {
          // Check if words start with the same prefix (at least 3 chars) or are close enough
          if (companyWord.startsWith(inputWord.substring(0, 3)) || inputWord.startsWith(companyWord.substring(0, 3))) {
            // Calculate similarity via Levenshtein on the word pair
            const wordDist = getLevenshteinDistance(inputWord, companyWord);
            const maxLen = Math.max(inputWord.length, companyWord.length);
            if (wordDist <= Math.ceil(maxLen * 0.4)) { // 40% tolerance per word
              matchScore += (maxLen - wordDist) / maxLen; // normalized score 0..1
            }
          }
        }
      }

      if (matchScore > bestWordScore) {
        bestWordScore = matchScore;
        bestWordMatch = company;
      }
    }

    // Require at least a meaningful score (at least one good word match)
    if (bestWordMatch && bestWordScore >= 0.5) {
      console.log(`[Resolver] Word-boundary match: "${rawName}" → "${bestWordMatch}" (score: ${bestWordScore.toFixed(2)})`);
      return { matched: bestWordMatch, isSuggested: true };
    }
  }

  // 3. Try Levenshtein fuzzy matching
  let closestMatch: string | null = null;
  let minDistance = Infinity;

  for (const company of allCompanies) {
    const dist = getLevenshteinDistance(sanitized.toLowerCase(), company.toLowerCase());
    if (dist < minDistance) {
      minDistance = dist;
      closestMatch = company;
    }
  }

  let threshold = 3;
  if (sanitized.length <= 3) {
    threshold = 1;
  } else if (sanitized.length <= 6) {
    threshold = 2;
  }

  if (closestMatch && minDistance <= threshold) {
    return { matched: closestMatch, isSuggested: true };
  }

  // 4. Reverse alias lookup — check if the input matches any VALUE in the alias map
  // This handles cases like "Hewlett Packard" matching even when stored differently
  const sanitizedUpper = sanitized.toUpperCase().replace(/[_\s]+/g, '_');
  for (const [aliasKey, candidates] of Object.entries(COMPANY_ALIASES)) {
    for (const candidate of candidates) {
      const candidateUpper = candidate.toUpperCase().replace(/[_\s]+/g, '_');
      if (candidateUpper === sanitizedUpper || sanitizedUpper.includes(candidateUpper) || candidateUpper.includes(sanitizedUpper)) {
        // Found a reverse match — now check DB for any alias candidate
        for (const dbCandidate of candidates) {
          const reverseMatch = await referralsCollection.findOne({
            company: { $regex: new RegExp(`^${escapeRegex(dbCandidate)}$`, 'i') },
            deletedAt: { $exists: false }
          } as any);
          if (reverseMatch) {
            console.log(`[Resolver] Reverse alias match: "${rawName}" → "${reverseMatch.company}" (via alias "${aliasKey}")`);
            return { matched: reverseMatch.company, isSuggested: true };
          }
        }
      }
    }
  }

  // No match found - treat as a brand new company name
  return { matched: sanitized, isSuggested: false };
}
