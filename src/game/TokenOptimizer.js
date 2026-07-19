/**
 * TokenOptimizer - Advanced token usage optimization for AI generation
 * Implements caching, compression, and intelligent prompt management
 */

export class TokenOptimizer {
  constructor(config = {}) {
    // Configuration
    this.config = {
      enableCaching: config.enableCaching !== false,
      enableCompression: config.enableCompression !== false,
      enableBatching: config.enableBatching !== false,
      cacheExpiry: config.cacheExpiry || 3600000, // 1 hour default
      maxCacheSize: config.maxCacheSize || 100, // Maximum cached items
      compressionLevel: config.compressionLevel || 'medium'
    };

    // Cache stores
    this.promptCache = new Map();
    this.styleCache = new Map();
    this.contextCache = new Map();
    this.responseCache = new Map();

    // Batch queue
    this.batchQueue = [];
    this.batchTimer = null;
    this.batchDelay = 100; // ms to wait before processing batch

    // Statistics tracking
    this.stats = {
      totalTokensSaved: 0,
      cacheHits: 0,
      cacheMisses: 0,
      batchedRequests: 0,
      compressionSavings: 0
    };

    // Prompt templates for efficient reuse
    this.promptTemplates = new Map();
    this.initializeTemplates();
  }

  /**
   * Initialize reusable prompt templates
   */
  initializeTemplates() {
    // System prompts that rarely change
    this.promptTemplates.set('orchestrator_system', {
      content: `You are an AI game asset orchestrator. Generate game configuration based on user prompts.
Your response must be valid JSON with specific structure.`,
      tokens: 25,
      hash: this.hashString('orchestrator_system')
    });

    this.promptTemplates.set('style_guide', {
      content: `Generate assets matching this style guide:
Art style: {artStyle}
Color palette: {colorPalette}
Lighting: {lighting}
Perspective: {perspective}`,
      tokens: 20,
      hash: this.hashString('style_guide')
    });

    this.promptTemplates.set('character_base', {
      content: `Create a {type} character sprite:
- Facing {facing}
- Full body visible
- Standing/idle pose
- Bottom-aligned for ground contact
- Transparent background
- Style: {style}`,
      tokens: 30,
      hash: this.hashString('character_base')
    });

    this.promptTemplates.set('background_layer', {
      content: `Create {layer} background layer:
- Parallax depth: {depth}
- Theme: {theme}
- No ground elements
- Seamless edges for tiling
- Style: {style}`,
      tokens: 25,
      hash: this.hashString('background_layer')
    });
  }

  /**
   * Optimize a prompt before sending to AI
   */
  optimizePrompt(prompt, context = {}) {
    let optimizedPrompt = prompt;
    let tokensSaved = 0;

    // Step 1: Check response cache
    const cacheKey = this.generateCacheKey(prompt, context);
    if (this.config.enableCaching && this.responseCache.has(cacheKey)) {
      const cached = this.responseCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.config.cacheExpiry) {
        this.stats.cacheHits++;
        this.stats.totalTokensSaved += this.estimateTokens(prompt);
        return {
          cached: true,
          response: cached.response,
          tokensSaved: this.estimateTokens(prompt)
        };
      }
    }
    this.stats.cacheMisses++;

    // Step 2: Apply template substitution
    const templated = this.applyTemplates(prompt, context);
    if (templated.modified) {
      tokensSaved += templated.tokensSaved;
      optimizedPrompt = templated.prompt;
    }

    // Step 3: Compress redundant information
    if (this.config.enableCompression) {
      const compressed = this.compressPrompt(optimizedPrompt, context);
      tokensSaved += compressed.tokensSaved;
      optimizedPrompt = compressed.prompt;
    }

    // Step 4: Extract and cache context
    if (context.styleGuide) {
      const styleKey = this.cacheStyleGuide(context.styleGuide);
      optimizedPrompt = optimizedPrompt.replace(
        JSON.stringify(context.styleGuide),
        `[STYLE:${styleKey}]`
      );
      tokensSaved += this.estimateTokens(JSON.stringify(context.styleGuide)) - 3;
    }

    this.stats.totalTokensSaved += tokensSaved;

    return {
      cached: false,
      prompt: optimizedPrompt,
      tokensSaved,
      cacheKey
    };
  }

  /**
   * Apply templates to reduce prompt size
   */
  applyTemplates(prompt, context) {
    let modifiedPrompt = prompt;
    let tokensSaved = 0;
    let modified = false;

    // Check if prompt matches any template pattern
    for (const [key, template] of this.promptTemplates) {
      const pattern = this.createPatternFromTemplate(template.content);
      if (pattern.test(prompt)) {
        // Extract variables from the prompt
        const variables = this.extractVariables(prompt, template.content);

        // Replace with template reference
        const reference = `[TEMPLATE:${key}:${JSON.stringify(variables)}]`;
        const originalTokens = this.estimateTokens(prompt);
        const newTokens = this.estimateTokens(reference);

        if (newTokens < originalTokens) {
          modifiedPrompt = reference;
          tokensSaved = originalTokens - newTokens;
          modified = true;
          break;
        }
      }
    }

    return { prompt: modifiedPrompt, tokensSaved, modified };
  }

  /**
   * Compress redundant information in prompts
   */
  compressPrompt(prompt, context) {
    let compressed = prompt;
    let tokensSaved = 0;

    // Remove redundant whitespace
    const whitespaceOptimized = prompt.replace(/\s+/g, ' ').trim();
    tokensSaved += this.estimateTokens(prompt) - this.estimateTokens(whitespaceOptimized);
    compressed = whitespaceOptimized;

    // Replace common long phrases with abbreviations
    const abbreviations = {
      'transparent background': 'trans-bg',
      'bottom-aligned': 'btm-align',
      'facing right': 'face-R',
      'facing left': 'face-L',
      'full body': 'full-body',
      'pixel art style': 'pixel-art',
      'seamless edges': 'seamless',
      'high detail': 'hi-detail',
      'medium detail': 'med-detail',
      'low detail': 'lo-detail'
    };

    for (const [full, abbr] of Object.entries(abbreviations)) {
      const regex = new RegExp(full, 'gi');
      if (regex.test(compressed)) {
        const newCompressed = compressed.replace(regex, abbr);
        const saved = this.estimateTokens(compressed) - this.estimateTokens(newCompressed);
        if (saved > 0) {
          compressed = newCompressed;
          tokensSaved += saved;
        }
      }
    }

    this.stats.compressionSavings += tokensSaved;

    return { prompt: compressed, tokensSaved };
  }

  /**
   * Cache a style guide and return reference key
   */
  cacheStyleGuide(styleGuide) {
    const key = this.hashObject(styleGuide);

    if (!this.styleCache.has(key)) {
      this.styleCache.set(key, {
        content: styleGuide,
        timestamp: Date.now(),
        uses: 0
      });

      // Manage cache size
      this.pruneCache(this.styleCache);
    }

    const cached = this.styleCache.get(key);
    cached.uses++;
    return key;
  }

  /**
   * Batch multiple requests for efficiency
   */
  async batchRequest(request) {
    if (!this.config.enableBatching) {
      return request.execute();
    }

    return new Promise((resolve, reject) => {
      // Add to queue
      this.batchQueue.push({
        request,
        resolve,
        reject,
        timestamp: Date.now()
      });

      // Reset timer
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
      }

      // Set new timer
      this.batchTimer = setTimeout(() => {
        this.processBatch();
      }, this.batchDelay);

      // Process immediately if queue is large
      if (this.batchQueue.length >= 10) {
        clearTimeout(this.batchTimer);
        this.processBatch();
      }
    });
  }

  /**
   * Process batched requests
   */
  async processBatch() {
    if (this.batchQueue.length === 0) return;

    const batch = [...this.batchQueue];
    this.batchQueue = [];
    this.stats.batchedRequests += batch.length;

    try {
      // Group similar requests
      const groups = this.groupSimilarRequests(batch);

      // Process each group
      for (const group of groups) {
        if (group.length === 1) {
          // Single request, process normally
          const item = group[0];
          try {
            const result = await item.request.execute();
            item.resolve(result);
          } catch (error) {
            item.reject(error);
          }
        } else {
          // Multiple similar requests, batch process
          const batchResult = await this.executeBatchRequest(group);
          group.forEach((item, index) => {
            item.resolve(batchResult[index]);
          });
        }
      }
    } catch (error) {
      // Reject all pending requests
      batch.forEach(item => item.reject(error));
    }
  }

  /**
   * Group similar requests for batch processing
   */
  groupSimilarRequests(requests) {
    const groups = [];
    const used = new Set();

    for (let i = 0; i < requests.length; i++) {
      if (used.has(i)) continue;

      const group = [requests[i]];
      used.add(i);

      for (let j = i + 1; j < requests.length; j++) {
        if (used.has(j)) continue;

        if (this.areSimilarRequests(requests[i].request, requests[j].request)) {
          group.push(requests[j]);
          used.add(j);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  /**
   * Check if two requests are similar enough to batch
   */
  areSimilarRequests(req1, req2) {
    // Check if same type and similar context
    return req1.type === req2.type &&
           req1.model === req2.model &&
           Math.abs(req1.maxTokens - req2.maxTokens) < 100;
  }

  /**
   * Execute a batch request
   */
  async executeBatchRequest(group) {
    // Combine prompts with delimiters
    const combinedPrompt = group.map(item => item.request.prompt).join('\n---BATCH_DELIMITER---\n');

    // Execute single request
    const response = await group[0].request.execute({
      prompt: combinedPrompt,
      maxTokens: Math.max(...group.map(item => item.request.maxTokens))
    });

    // Split response
    const responses = response.split('---BATCH_DELIMITER---');
    return responses;
  }

  /**
   * Cache a response for future reuse
   */
  cacheResponse(cacheKey, response) {
    if (!this.config.enableCaching) return;

    this.responseCache.set(cacheKey, {
      response,
      timestamp: Date.now(),
      uses: 0
    });

    // Manage cache size
    this.pruneCache(this.responseCache);
  }

  /**
   * Prune old cache entries
   */
  pruneCache(cache) {
    if (cache.size <= this.config.maxCacheSize) return;

    // Remove oldest entries
    const entries = Array.from(cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = entries.slice(0, cache.size - this.config.maxCacheSize);
    toRemove.forEach(([key]) => cache.delete(key));
  }

  /**
   * Estimate token count for a string
   */
  estimateTokens(text) {
    // Rough estimation: 1 token per 4 characters
    // More accurate would use tiktoken or similar
    return Math.ceil(text.length / 4);
  }

  /**
   * Generate cache key for a prompt
   */
  generateCacheKey(prompt, context) {
    const combined = prompt + JSON.stringify(context);
    return this.hashString(combined);
  }

  /**
   * Hash a string for caching
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Hash an object for caching
   */
  hashObject(obj) {
    return this.hashString(JSON.stringify(obj));
  }

  /**
   * Create pattern from template
   */
  createPatternFromTemplate(template) {
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/\{(\w+)\}/g, '(.+)');
    return new RegExp(pattern, 'i');
  }

  /**
   * Extract variables from prompt based on template
   */
  extractVariables(prompt, template) {
    const pattern = this.createPatternFromTemplate(template);
    const match = prompt.match(pattern);

    if (!match) return {};

    const variableNames = template.match(/\{(\w+)\}/g)?.map(v => v.slice(1, -1)) || [];
    const variables = {};

    variableNames.forEach((name, index) => {
      variables[name] = match[index + 1];
    });

    return variables;
  }

  /**
   * Get optimization statistics
   */
  getStats() {
    const avgCacheHitRate = this.stats.cacheHits /
                           (this.stats.cacheHits + this.stats.cacheMisses) || 0;

    return {
      ...this.stats,
      avgCacheHitRate: (avgCacheHitRate * 100).toFixed(2) + '%',
      estimatedCostSavings: (this.stats.totalTokensSaved * 0.00001).toFixed(4) + ' USD',
      cacheSize: {
        prompt: this.promptCache.size,
        style: this.styleCache.size,
        context: this.contextCache.size,
        response: this.responseCache.size
      }
    };
  }

  /**
   * Clear all caches
   */
  clearCache() {
    this.promptCache.clear();
    this.styleCache.clear();
    this.contextCache.clear();
    this.responseCache.clear();

    console.log('TokenOptimizer: All caches cleared');
  }

  /**
   * Export cache for persistence
   */
  exportCache() {
    return {
      prompt: Array.from(this.promptCache.entries()),
      style: Array.from(this.styleCache.entries()),
      context: Array.from(this.contextCache.entries()),
      response: Array.from(this.responseCache.entries()),
      stats: this.stats
    };
  }

  /**
   * Import cache from export
   */
  importCache(data) {
    if (data.prompt) this.promptCache = new Map(data.prompt);
    if (data.style) this.styleCache = new Map(data.style);
    if (data.context) this.contextCache = new Map(data.context);
    if (data.response) this.responseCache = new Map(data.response);
    if (data.stats) this.stats = data.stats;

    console.log('TokenOptimizer: Cache imported successfully');
  }

  /**
   * Optimize parallel requests
   */
  optimizeParallelRequests(requests) {
    // Identify shared context
    const sharedContext = this.extractSharedContext(requests);

    // Create optimized requests
    return requests.map(req => ({
      ...req,
      prompt: this.removeSharedContext(req.prompt, sharedContext),
      sharedContextRef: this.cacheContext(sharedContext)
    }));
  }

  /**
   * Extract shared context from multiple requests
   */
  extractSharedContext(requests) {
    if (requests.length < 2) return null;

    // Find common prefixes/suffixes
    const prompts = requests.map(r => r.prompt);
    const commonPrefix = this.findCommonPrefix(prompts);
    const commonSuffix = this.findCommonSuffix(prompts);

    if (commonPrefix.length > 20 || commonSuffix.length > 20) {
      return {
        prefix: commonPrefix,
        suffix: commonSuffix
      };
    }

    return null;
  }

  /**
   * Find common prefix in strings
   */
  findCommonPrefix(strings) {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0];

    let prefix = '';
    const firstString = strings[0];

    for (let i = 0; i < firstString.length; i++) {
      const char = firstString[i];
      if (strings.every(s => s[i] === char)) {
        prefix += char;
      } else {
        break;
      }
    }

    return prefix;
  }

  /**
   * Find common suffix in strings
   */
  findCommonSuffix(strings) {
    const reversed = strings.map(s => s.split('').reverse().join(''));
    const commonPrefix = this.findCommonPrefix(reversed);
    return commonPrefix.split('').reverse().join('');
  }

  /**
   * Remove shared context from prompt
   */
  removeSharedContext(prompt, sharedContext) {
    if (!sharedContext) return prompt;

    let modified = prompt;
    if (sharedContext.prefix) {
      modified = modified.replace(sharedContext.prefix, '[PREFIX]');
    }
    if (sharedContext.suffix) {
      modified = modified.replace(sharedContext.suffix, '[SUFFIX]');
    }

    return modified;
  }

  /**
   * Cache context and return reference
   */
  cacheContext(context) {
    if (!context) return null;

    const key = this.hashObject(context);
    this.contextCache.set(key, {
      content: context,
      timestamp: Date.now()
    });

    return key;
  }
}

export default TokenOptimizer;