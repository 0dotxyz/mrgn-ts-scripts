/**
 * Web Scraper Utility
 *
 * Uses puppeteer-core to render JavaScript-heavy pages (like Kamino)
 * and extract content that would otherwise require a browser.
 *
 * Requires Chrome/Chromium to be installed on the system.
 * Install with: apt install chromium-browser (Linux) or brew install chromium (macOS)
 */

import puppeteer, { Browser, Page } from "puppeteer-core";
import { execSync } from "child_process";

/**
 * Common Chrome/Chromium executable paths
 */
const CHROME_PATHS = [
  // Linux
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Windows (WSL)
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

/**
 * Find Chrome/Chromium executable path
 */
export function findChromePath(): string | null {
  // Try which command first
  try {
    const result = execSync("which chromium chromium-browser google-chrome google-chrome-stable 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    if (result) {
      return result.split("\n")[0];
    }
  } catch {
    // Ignore errors from which command
  }

  // Check common paths
  for (const path of CHROME_PATHS) {
    try {
      execSync(`test -x "${path}"`, { encoding: "utf-8" });
      return path;
    } catch {
      // Path doesn't exist or isn't executable
    }
  }

  return null;
}

export interface ScrapeOptions {
  /** Wait for this selector before extracting content */
  waitForSelector?: string;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Extract specific element text instead of full page */
  extractSelector?: string;
  /** Return raw HTML instead of text */
  returnHtml?: boolean;
}

export interface ScrapeResult {
  success: boolean;
  content?: string;
  error?: string;
  url: string;
}

let browserInstance: Browser | null = null;

/**
 * Get or create a browser instance
 */
async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      "Chrome/Chromium not found. Install with:\n" +
        "  Linux: apt install chromium-browser\n" +
        "  macOS: brew install chromium"
    );
  }

  browserInstance = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  return browserInstance;
}

/**
 * Close the browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Scrape a JavaScript-rendered page
 *
 * @param url URL to scrape
 * @param options Scrape options
 * @returns Scraped content or error
 */
export async function scrapeRenderedPage(
  url: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const { waitForSelector, timeout = 30000, extractSelector, returnHtml = false } = options;

  let page: Page | null = null;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Set a reasonable viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to the page
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout,
    });

    // Wait for specific selector if provided
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout });
    }

    // Extract content
    let content: string;

    if (extractSelector) {
      // Extract specific element
      const element = await page.$(extractSelector);
      if (!element) {
        return {
          success: false,
          error: `Selector "${extractSelector}" not found`,
          url,
        };
      }
      content = returnHtml
        ? await page.evaluate((el) => el.outerHTML, element)
        : await page.evaluate((el) => el.textContent || "", element);
    } else {
      // Extract full page
      content = returnHtml
        ? await page.content()
        : await page.evaluate(() => document.body.innerText);
    }

    return {
      success: true,
      content: content.trim(),
      url,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      url,
    };
  } finally {
    if (page) {
      await page.close();
    }
  }
}
