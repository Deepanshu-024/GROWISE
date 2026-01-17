"use server"

import Firecrawl from '@mendable/firecrawl-js';

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });

export async function scrapeWebsite(url: string) {
  try {
    const scrapeResponse = await firecrawl.scrape(url, {
      formats: ['markdown'],
    });
    console.log(scrapeResponse)
  } catch (error) {
    console.error('Error scraping website:', error);
  }
}