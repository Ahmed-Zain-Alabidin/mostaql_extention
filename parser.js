/**
 * parser.js - Isolated HTML Parsing Logic for Mostaql Projects
 * 
 * Extracts project ID, title, description, time, budget, and category
 * using robust DOM parsing or direct Regex/String parsing.
 */

export function unescapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&rlm;|&lrm;/g, '')
    .trim();
}

export function normalizeArabicText(text) {
  if (!text) return '';
  return text
    .replace(/[\u064B-\u065F\u0670]/g, '') // remove Arabic diacritics
    .replace(/\u0640/g, '')                 // remove tatweel (_)
    .trim();
}

export function parseJobsFromHTML(html, ParserClass = typeof DOMParser !== 'undefined' ? DOMParser : null) {
  if (!html || typeof html !== 'string') {
    return [];
  }

  // If DOMParser is available, use DOM parsing first
  if (ParserClass) {
    try {
      const parser = new ParserClass();
      const doc = parser.parseFromString(html, 'text/html');
      const domJobs = parseJobsFromDOM(doc);
      if (domJobs && domJobs.length > 0) {
        return domJobs;
      }
    } catch (e) {
      console.warn('[Parser] DOM parsing error, falling back to regex:', e);
    }
  }

  // Fallback to high-speed regex parser
  return parseJobsWithRegex(html);
}

export function parseJobsFromDOM(doc) {
  const jobs = [];
  const seenIds = new Set();

  // Find all project rows or cards
  const projectRows = doc.querySelectorAll('tr.project-row, .project-row, .project__row, .m-card, tr[data-project-id]');

  if (projectRows && projectRows.length > 0) {
    for (const row of projectRows) {
      // Find the main title link
      const titleLink = row.querySelector('h2 a[href*="/project/"], .card--title a[href*="/project/"], .project__title a[href*="/project/"], a.hs-project-link, a.details-url') 
        || row.querySelector('a[href*="/project/"]:not([href*="template"]):not([href*="create"]):not([href*="register"])');
      
      if (!titleLink) continue;

      const href = titleLink.getAttribute('href') || '';
      const idMatch = href.match(/\/project\/(\d+)/i);
      if (!idMatch) continue;

      const id = idMatch[1];
      if (seenIds.has(id)) continue;

      const rawTitle = titleLink.textContent?.trim() || '';
      const title = unescapeHtml(rawTitle.replace(/\s+/g, ' '));
      if (!title || title.length < 2) continue;

      const fullUrl = href.startsWith('http') ? href : `https://mostaql.com${href.startsWith('/') ? '' : '/'}${href}`;

      // Time
      let postedTime = 'الآن';
      const timeEl = row.querySelector('time, .project__time, [itemprop="datePublished"]');
      if (timeEl) {
        postedTime = unescapeHtml(timeEl.textContent?.replace(/\s+/g, ' ').trim() || postedTime);
      }

      // Brief / Description
      let description = '';
      const briefEl = row.querySelector('.project__brief, .text-wrapper-div, [itemprop="description"], .project-brief');
      if (briefEl) {
        description = unescapeHtml(briefEl.textContent?.replace(/\s+/g, ' ').trim() || '');
      }

      // Budget
      let budget = 'حسب الاتفاق';
      const budgetEl = row.querySelector('.project__budget, .budget');
      if (budgetEl) {
        budget = unescapeHtml(budgetEl.textContent?.replace(/\s+/g, ' ').trim() || budget);
      }

      // Category
      let category = 'مستقل';
      const catEl = row.querySelector('.project__category, .category');
      if (catEl) {
        category = unescapeHtml(catEl.textContent?.replace(/\s+/g, ' ').trim() || category);
      }

      seenIds.add(id);
      jobs.push({
        id,
        title,
        url: fullUrl,
        budget,
        postedTime,
        category,
        description: description.slice(0, 500)
      });
    }
  }

  // Fallback to pure anchor scanner if table rows selector didn't match
  if (jobs.length === 0) {
    const projectLinks = doc.querySelectorAll('a[href*="/project/"]');
    for (const link of projectLinks) {
      const href = link.getAttribute('href') || '';
      if (href.includes('create') || href.includes('template') || href.includes('register') || href.includes('login')) continue;

      const idMatch = href.match(/\/project\/(\d+)/i);
      if (!idMatch) continue;

      const id = idMatch[1];
      if (seenIds.has(id)) continue;

      const rawTitle = link.textContent?.trim() || '';
      const title = unescapeHtml(rawTitle.replace(/\s+/g, ' '));
      if (!title || title.length < 2) continue;

      seenIds.add(id);
      const fullUrl = href.startsWith('http') ? href : `https://mostaql.com${href.startsWith('/') ? '' : '/'}${href}`;

      jobs.push({
        id,
        title,
        url: fullUrl,
        budget: 'حسب الاتفاق',
        postedTime: 'الآن',
        category: 'مستقل',
        description: ''
      });
    }
  }

  return jobs;
}

export function parseJobsWithRegex(html) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];
  const seenIds = new Set();

  // Pattern 1: Parse structured rows <tr class="project-row"...>...</tr>
  const rowRegex = /<tr[^>]*class=["'][^"']*project-row[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const titleMatch = rowHtml.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']*\/project\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i)
      || rowHtml.match(/<a[^>]+href=["']([^"']*\/project\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);

    if (!titleMatch) continue;

    const href = titleMatch[1];
    const id = titleMatch[2];
    if (seenIds.has(id)) continue;

    const rawTitle = titleMatch[3].replace(/<[^>]+>/g, '').trim();
    const title = unescapeHtml(rawTitle.replace(/\s+/g, ' '));
    if (!title || title.length < 2 || href.includes('template') || href.includes('create') || href.includes('register') || href.includes('login')) continue;

    const fullUrl = href.startsWith('http') ? href : `https://mostaql.com${href.startsWith('/') ? '' : '/'}${href}`;

    // Time
    let postedTime = 'الآن';
    const timeMatch = rowHtml.match(/<time[^>]*>([\s\S]*?)<\/time>/i);
    if (timeMatch) {
      postedTime = unescapeHtml(timeMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || postedTime);
    }

    // Description
    let description = '';
    const descMatch = rowHtml.match(/<p[^>]*class=["'][^"']*(?:project__brief|text-wrapper-div)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    if (descMatch) {
      description = unescapeHtml(descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '');
    }

    // Budget
    let budget = 'حسب الاتفاق';
    const budgetMatch = rowHtml.match(/class=["'][^"']*(?:project__budget|budget)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div|li|td)>/i);
    if (budgetMatch) {
      budget = unescapeHtml(budgetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || budget);
    }

    // Category
    let category = 'مستقل';
    const catMatch = rowHtml.match(/class=["'][^"']*(?:project__category|category)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|div|span|a)>/i);
    if (catMatch) {
      category = unescapeHtml(catMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || category);
    }

    seenIds.add(id);
    jobs.push({
      id,
      title,
      url: fullUrl,
      budget,
      postedTime,
      category,
      description: description.slice(0, 500)
    });
  }

  // Pattern 2 Fallback: If no structured rows matched
  if (jobs.length === 0) {
    const linkRegex = /<a[^>]+href=["']([^"']*\/project\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const id = match[2];
      if (seenIds.has(id)) continue;

      const rawTitle = match[3].replace(/<[^>]+>/g, '').trim();
      const title = unescapeHtml(rawTitle.replace(/\s+/g, ' '));
      if (!title || title.length < 2 || href.includes('template') || href.includes('create') || href.includes('register') || href.includes('login')) continue;

      seenIds.add(id);
      const fullUrl = href.startsWith('http') ? href : `https://mostaql.com${href.startsWith('/') ? '' : '/'}${href}`;

      jobs.push({
        id,
        title,
        url: fullUrl,
        budget: 'حسب الاتفاق',
        postedTime: 'الآن',
        category: 'مستقل',
        description: ''
      });
    }
  }

  return jobs;
}
