/**
 * SpriteAlignmentManager - Intelligent sprite positioning and alignment system
 * Ensures perfect ground contact, correct orientation, and consistent positioning
 */

export class SpriteAlignmentManager {
  constructor(scene) {
    this.scene = scene;

    // Configuration
    this.config = {
      autoAlign: true,
      detectGroundContact: true,
      enforceOrientation: true,
      debugMode: false
    };

    // Cached analysis results
    this.analysisCache = new Map();

    // Sprite tracking
    this.managedSprites = new Set();

    // Ground detection settings
    this.groundDetection = {
      alphaThreshold: 10, // Minimum alpha to consider a pixel "solid"
      scanLines: 5, // Number of lines to scan for foot position
      edgePadding: 2 // Pixels to ignore at edges
    };
  }

  /**
   * Initialize a sprite with proper alignment
   */
  initializeSprite(sprite, options = {}) {
    const {
      type = 'character', // 'character', 'enemy', 'obstacle', 'platform'
      groundY = this.scene.LOGICAL_FLOOR_Y || 1000,
      facing = 'right',
      anchor = 'bottom-center',
      autoScale = true,
      knownFacing = null
    } = options;

    // Add to managed sprites
    this.managedSprites.add(sprite);

    // Store metadata
    sprite.alignmentData = {
      type,
      groundY,
      facing,
      anchor,
      originalWidth: sprite.width,
      originalHeight: sprite.height
    };

    // Analyze sprite texture for ground contact point
    const analysis = this.analyzeSprite(sprite);
    sprite.alignmentData.analysis = analysis;

    // A pipeline-verified base facing overrides the pixel-density guess — the guess
    // misfires on unusual silhouettes, and flipping is always computed relative to
    // facingDirection (cached-object mutation intentional: same texture, all future
    // enforceOrientation/updateFacing calls must use the verified value)
    if (knownFacing && analysis) {
      analysis.facingDirection = knownFacing;
    }

    // Set anchor point
    this.setAnchorPoint(sprite, anchor);

    // Apply auto-scaling if needed
    if (autoScale) {
      this.autoScaleSprite(sprite, type);
    }

    // Align to ground
    this.alignToGround(sprite, groundY);

    // Ensure correct orientation
    this.enforceOrientation(sprite, facing);

    // Set up collision box
    this.optimizeCollisionBox(sprite, analysis);

    // Add debug visualization if enabled
    if (this.config.debugMode) {
      this.addDebugVisualization(sprite);
    }

    return sprite;
  }

  /**
   * Analyze sprite texture to find ground contact point and boundaries
   */
  analyzeSprite(sprite) {
    const cacheKey = sprite.texture.key + '_' + sprite.frame.name;

    // Check cache first
    if (this.analysisCache.has(cacheKey)) {
      return this.analysisCache.get(cacheKey);
    }

    // Get texture data
    const texture = sprite.texture;
    const frame = sprite.frame;

    // Create temporary canvas for analysis
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = frame.width;
    canvas.height = frame.height;

    // Draw sprite to canvas
    const source = texture.getSourceImage();
    ctx.drawImage(
      source,
      frame.x, frame.y,
      frame.width, frame.height,
      0, 0,
      frame.width, frame.height
    );

    // Get pixel data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    const analysis = {
      footY: 0,
      centerOfMassX: 0,
      centerOfMassY: 0,
      boundingBox: {
        left: canvas.width,
        right: 0,
        top: canvas.height,
        bottom: 0
      },
      hasTransparency: false,
      facingDirection: 'right',
      groundContactWidth: 0
    };

    // Find bounding box and center of mass
    let pixelCount = 0;
    let totalX = 0;
    let totalY = 0;

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const idx = (y * canvas.width + x) * 4;
        const alpha = data[idx + 3];

        if (alpha > this.groundDetection.alphaThreshold) {
          // Update bounding box
          analysis.boundingBox.left = Math.min(analysis.boundingBox.left, x);
          analysis.boundingBox.right = Math.max(analysis.boundingBox.right, x);
          analysis.boundingBox.top = Math.min(analysis.boundingBox.top, y);
          analysis.boundingBox.bottom = Math.max(analysis.boundingBox.bottom, y);

          // Calculate center of mass
          totalX += x;
          totalY += y;
          pixelCount++;
        } else {
          analysis.hasTransparency = true;
        }
      }
    }

    // Calculate center of mass
    if (pixelCount > 0) {
      analysis.centerOfMassX = Math.round(totalX / pixelCount);
      analysis.centerOfMassY = Math.round(totalY / pixelCount);
    }

    // Find foot position (bottom-most non-transparent pixels)
    analysis.footY = this.findFootPosition(data, canvas.width, canvas.height);

    // Detect ground contact width
    analysis.groundContactWidth = this.detectGroundContactWidth(
      data,
      canvas.width,
      canvas.height,
      analysis.footY
    );

    // Detect facing direction
    analysis.facingDirection = this.detectFacingDirection(
      data,
      canvas.width,
      canvas.height,
      analysis
    );

    // Cache the analysis
    this.analysisCache.set(cacheKey, analysis);

    return analysis;
  }

  /**
   * Find the Y position of the sprite's feet
   */
  findFootPosition(data, width, height) {
    // Scan from bottom up to find the lowest non-transparent row
    for (let y = height - 1; y >= 0; y--) {
      let hasPixels = false;

      // Check if this row has any non-transparent pixels
      for (let x = this.groundDetection.edgePadding;
           x < width - this.groundDetection.edgePadding;
           x++) {
        const idx = (y * width + x) * 4;
        const alpha = data[idx + 3];

        if (alpha > this.groundDetection.alphaThreshold) {
          hasPixels = true;
          break;
        }
      }

      if (hasPixels) {
        // Found the foot position
        return y;
      }
    }

    // No pixels found, return bottom
    return height - 1;
  }

  /**
   * Detect the width of ground contact area
   */
  detectGroundContactWidth(data, width, height, footY) {
    let leftMost = width;
    let rightMost = 0;

    // Scan the foot row and a few rows above
    for (let y = footY; y >= Math.max(0, footY - this.groundDetection.scanLines); y--) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const alpha = data[idx + 3];

        if (alpha > this.groundDetection.alphaThreshold) {
          leftMost = Math.min(leftMost, x);
          rightMost = Math.max(rightMost, x);
        }
      }
    }

    return rightMost > leftMost ? rightMost - leftMost : 0;
  }

  /**
   * Detect which direction the sprite is facing
   */
  detectFacingDirection(data, width, height, analysis) {
    // Compare pixel density on left vs right side of center of mass
    let leftPixels = 0;
    let rightPixels = 0;

    const centerX = analysis.centerOfMassX;

    for (let y = analysis.boundingBox.top; y <= analysis.boundingBox.bottom; y++) {
      for (let x = analysis.boundingBox.left; x <= analysis.boundingBox.right; x++) {
        const idx = (y * width + x) * 4;
        const alpha = data[idx + 3];

        if (alpha > this.groundDetection.alphaThreshold) {
          if (x < centerX) {
            leftPixels++;
          } else if (x > centerX) {
            rightPixels++;
          }
        }
      }
    }

    // More pixels on the right side typically means facing right
    // (because characters usually have more detail in front)
    return rightPixels > leftPixels * 1.1 ? 'right' : 'left';
  }

  /**
   * Set the anchor point of the sprite
   */
  setAnchorPoint(sprite, anchor) {
    switch(anchor) {
      case 'bottom-center':
        sprite.setOrigin(0.5, 1);
        break;
      case 'bottom-left':
        sprite.setOrigin(0, 1);
        break;
      case 'bottom-right':
        sprite.setOrigin(1, 1);
        break;
      case 'center':
        sprite.setOrigin(0.5, 0.5);
        break;
      case 'top-center':
        sprite.setOrigin(0.5, 0);
        break;
      default:
        // Custom origin [x, y]
        if (Array.isArray(anchor) && anchor.length === 2) {
          sprite.setOrigin(anchor[0], anchor[1]);
        }
    }
  }

  /**
   * Auto-scale sprite based on type
   */
  autoScaleSprite(sprite, type) {
    const targetSizes = {
      'character': 64,
      'enemy': 50,
      'obstacle': 80,
      'platform': 32,
      'item': 32
    };

    const targetHeight = targetSizes[type] || 64;
    const scale = targetHeight / sprite.height;

    sprite.setScale(scale);
  }

  /**
   * Align sprite to ground with perfect contact
   */
  alignToGround(sprite, groundY) {
    const analysis = sprite.alignmentData.analysis;

    if (!analysis) {
      // Fallback to simple positioning
      sprite.y = groundY;
      return;
    }

    // Distance from the frame's bottom edge to the detected foot row, in DISPLAY
    // pixels (both terms must be scaled together — mixing unscaled frame height
    // with a scaled foot position used to shove characters into the floor).
    const footOffset = (sprite.height - 1 - analysis.footY) * sprite.scaleY;

    // Origin is bottom-center: sprite.y is the frame bottom, feet sit footOffset above
    sprite.y = groundY + footOffset;

    // Store the calculated position
    sprite.alignmentData.alignedY = sprite.y;
    sprite.alignmentData.footOffset = footOffset;
  }

  /**
   * Ensure sprite faces the correct direction
   */
  enforceOrientation(sprite, desiredFacing) {
    const analysis = sprite.alignmentData.analysis;

    if (!analysis) {
      // Simple flip based on desired facing
      sprite.setFlipX(desiredFacing === 'left');
      return;
    }

    // Check if sprite's natural facing matches desired
    const needsFlip = (analysis.facingDirection !== desiredFacing);
    sprite.setFlipX(needsFlip);

    // Update facing in metadata
    sprite.alignmentData.currentFacing = desiredFacing;
  }

  /**
   * Optimize collision box based on sprite analysis
   */
  optimizeCollisionBox(sprite, analysis) {
    if (!sprite.body) {
      // No physics body
      return;
    }

    const bbox = analysis.boundingBox;

    // Arcade's setSize/setOffset take UNSCALED frame pixels — the body is scaled by
    // the sprite's scale automatically. Passing pre-scaled values here double-scaled
    // the body (a 0.58x player got a 0.33x body), so physics rested a shrunken box
    // on the floor and the sprite's legs rendered inside the ground.
    const actualWidth = bbox.right - bbox.left + 1;
    const actualHeight = bbox.bottom - bbox.top + 1;

    // Set collision box to match visible pixels
    sprite.body.setSize(actualWidth, actualHeight);
    sprite.body.setOffset(bbox.left, bbox.top);

    // For ground-based sprites, ensure bottom of collision box aligns with feet
    if (sprite.alignmentData.type === 'character' ||
        sprite.alignmentData.type === 'enemy') {
      sprite.body.setOffset(bbox.left, analysis.footY + 1 - actualHeight);
    }
  }

  /**
   * Add debug visualization for alignment
   */
  addDebugVisualization(sprite) {
    const graphics = this.scene.add.graphics();
    graphics.setDepth(1000);

    // Draw bounding box
    const bbox = sprite.alignmentData.analysis.boundingBox;
    graphics.lineStyle(1, 0x00ff00);
    graphics.strokeRect(
      sprite.x - sprite.width * sprite.originX + bbox.left * sprite.scaleX,
      sprite.y - sprite.height * sprite.originY + bbox.top * sprite.scaleY,
      (bbox.right - bbox.left) * sprite.scaleX,
      (bbox.bottom - bbox.top) * sprite.scaleY
    );

    // Draw foot position line
    graphics.lineStyle(2, 0xff0000);
    graphics.lineBetween(
      sprite.x - 20,
      sprite.alignmentData.alignedY,
      sprite.x + 20,
      sprite.alignmentData.alignedY
    );

    // Draw center of mass
    const com = sprite.alignmentData.analysis;
    graphics.fillStyle(0xffff00);
    graphics.fillCircle(
      sprite.x - sprite.width * sprite.originX + com.centerOfMassX * sprite.scaleX,
      sprite.y - sprite.height * sprite.originY + com.centerOfMassY * sprite.scaleY,
      3
    );

    // Store debug graphics for cleanup
    sprite.debugGraphics = graphics;
  }

  /**
   * Update sprite alignment (call this if sprite moves or changes)
   */
  updateAlignment(sprite) {
    if (!this.managedSprites.has(sprite)) {
      return;
    }

    const data = sprite.alignmentData;

    // Re-align to ground if needed
    if (data.groundY && this.config.autoAlign) {
      this.alignToGround(sprite, data.groundY);
    }

    // Ensure orientation is still correct
    if (this.config.enforceOrientation) {
      this.enforceOrientation(sprite, data.currentFacing || data.facing);
    }
  }

  /**
   * Batch process multiple sprites
   */
  processSprites(sprites, options = {}) {
    const results = [];

    sprites.forEach(sprite => {
      results.push(this.initializeSprite(sprite, options));
    });

    return results;
  }

  /**
   * Update facing direction for movement
   */
  updateFacing(sprite, velocityX) {
    if (!this.managedSprites.has(sprite)) {
      return;
    }

    const newFacing = velocityX > 0 ? 'right' : velocityX < 0 ? 'left' : sprite.alignmentData.currentFacing;

    if (newFacing !== sprite.alignmentData.currentFacing) {
      this.enforceOrientation(sprite, newFacing);
    }
  }

  /**
   * Check if sprite is properly grounded
   */
  isGrounded(sprite) {
    if (!sprite.body) {
      return true; // Non-physics sprites are always "grounded"
    }

    const groundY = sprite.alignmentData?.groundY || this.scene.LOGICAL_FLOOR_Y;
    const footY = sprite.y + (sprite.alignmentData?.footOffset || 0);

    return Math.abs(footY - groundY) < 2; // Within 2 pixels of ground
  }

  /**
   * Clean up a managed sprite
   */
  removeSprite(sprite) {
    this.managedSprites.delete(sprite);

    if (sprite.debugGraphics) {
      sprite.debugGraphics.destroy();
    }
  }

  /**
   * Clean up all managed sprites
   */
  destroy() {
    this.managedSprites.forEach(sprite => {
      if (sprite.debugGraphics) {
        sprite.debugGraphics.destroy();
      }
    });

    this.managedSprites.clear();
    this.analysisCache.clear();
  }

  /**
   * Enable/disable debug mode
   */
  setDebugMode(enabled) {
    this.config.debugMode = enabled;

    if (!enabled) {
      // Clean up existing debug graphics
      this.managedSprites.forEach(sprite => {
        if (sprite.debugGraphics) {
          sprite.debugGraphics.destroy();
          sprite.debugGraphics = null;
        }
      });
    } else {
      // Add debug visualization to existing sprites
      this.managedSprites.forEach(sprite => {
        if (!sprite.debugGraphics) {
          this.addDebugVisualization(sprite);
        }
      });
    }
  }
}

export default SpriteAlignmentManager;