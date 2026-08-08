import React from 'react';

interface ProductImageGalleryProps {
  primaryImage: string | null;
  additionalImages: string[];
  activeImageIdx: number;
  setActiveImageIdx: React.Dispatch<React.SetStateAction<number>>;
  manualImageUrl: string;
  setManualImageUrl: React.Dispatch<React.SetStateAction<string>>;
  onSetPrimary: (url: string) => void;
  onRemoveImage: (url: string, isPrimary: boolean) => void;
  onAddManualUrl: (url: string) => void;
}

export function ProductImageGallery({
  primaryImage,
  additionalImages,
  activeImageIdx,
  setActiveImageIdx,
  manualImageUrl,
  setManualImageUrl,
  onSetPrimary,
  onRemoveImage,
  onAddManualUrl,
}: ProductImageGalleryProps) {
  const allImages = [
    ...(primaryImage ? [{ url: primaryImage, isPrimary: true }] : []),
    ...(additionalImages || []).map((img) => ({ url: img, isPrimary: false })),
  ];

  const activeIndex =
    allImages.length > 0 ? Math.min(activeImageIdx, Math.max(0, allImages.length - 1)) : -1;
  const activeImage = activeIndex !== -1 ? allImages[activeIndex] : null;
  const activeImgSrc = activeImage
    ? activeImage.url.startsWith('products/')
      ? `/api/onboarding/${activeImage.url}`
      : activeImage.url
    : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          🖼️ Product Images & Variants
        </h3>
        <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
          Select primary catalog image or remove incorrect color variants.
        </p>
      </div>

      {allImages.length === 0 ? (
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: 140,
            border: '2px dashed #d1d5db',
            borderRadius: 10,
            background: '#f9fafb',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            boxSizing: 'border-box',
            padding: 16,
            color: '#6b7280',
            fontSize: 13,
          }}
        >
          No images available. Add an image URL below to get started.
        </div>
      ) : (
        <>
          {/* Main Focused Image View */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: 280,
              border: `2px solid ${activeImage?.isPrimary ? '#10b981' : '#e5e7eb'}`,
              borderRadius: 12,
              background: activeImage?.isPrimary ? '#f0fdf4' : '#f9fafb',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              boxShadow: activeImage?.isPrimary
                ? '0 4px 12px rgba(16, 185, 129, 0.08)'
                : '0 2px 8px rgba(0,0,0,0.03)',
              padding: 12,
              boxSizing: 'border-box',
            }}
          >
            {activeImage && (
              <img
                src={activeImgSrc}
                alt="Active product view"
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  borderRadius: 8,
                }}
              />
            )}

            {/* Image Status Pill overlay */}
            {activeImage && (
              <span
                style={{
                  position: 'absolute',
                  top: 12,
                  left: 12,
                  fontSize: 11,
                  fontWeight: 700,
                  color: activeImage.isPrimary ? '#065f46' : '#374151',
                  background: activeImage.isPrimary ? '#d1fae5' : '#e5e7eb',
                  padding: '4px 10px',
                  borderRadius: 20,
                  boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                }}
              >
                {activeImage.isPrimary ? '★ Primary Image' : 'Variant Image'}
              </span>
            )}
          </div>

          {/* Active Image Action Controls */}
          {activeImage && (
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              {!activeImage.isPrimary && (
                <button
                  type="button"
                  onClick={() => onSetPrimary(activeImage.url)}
                  style={{
                    padding: '8px 16px',
                    minHeight: 36,
                    fontSize: 12,
                    fontWeight: 600,
                    background: '#10b981',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    boxShadow: '0 2px 4px rgba(16, 185, 129, 0.2)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#059669';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#10b981';
                  }}
                >
                  Set as Primary Image
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (confirm('Are you sure you want to remove this image?')) {
                    onRemoveImage(activeImage.url, activeImage.isPrimary);
                  }
                }}
                style={{
                  padding: '8px 16px',
                  minHeight: 36,
                  fontSize: 12,
                  fontWeight: 600,
                  background: '#fff',
                  border: '1px solid #fca5a5',
                  color: '#dc2626',
                  borderRadius: 6,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#fee2e2';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#fff';
                }}
              >
                Remove This Image
              </button>
            </div>
          )}

          {/* Thumbnails strip */}
          <div
            style={{
              display: 'flex',
              gap: 10,
              overflowX: 'auto',
              padding: '6px 2px 8px 2px',
              borderTop: '1px solid #f3f4f6',
              scrollbarWidth: 'thin',
            }}
          >
            {allImages.map((img, idx) => {
              const isCurrent = idx === activeIndex;
              const imgSrc = img.url.startsWith('products/')
                ? `/api/onboarding/${img.url}`
                : img.url;
              return (
                <div
                  key={idx}
                  onClick={() => setActiveImageIdx(idx)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveImageIdx(idx);
                    }
                  }}
                  aria-label={`Select image ${idx + 1}`}
                  style={{
                    position: 'relative',
                    width: 64,
                    height: 64,
                    flexShrink: 0,
                    border: isCurrent
                      ? '2px solid #7c3aed'
                      : img.isPrimary
                      ? '2px solid #10b981'
                      : '1px solid #e5e7eb',
                    borderRadius: 8,
                    padding: 2,
                    background: '#fff',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    boxSizing: 'border-box',
                    opacity: isCurrent ? 1 : 0.75,
                  }}
                  onMouseEnter={(e) => {
                    if (!isCurrent) e.currentTarget.style.opacity = '1';
                  }}
                  onMouseLeave={(e) => {
                    if (!isCurrent) e.currentTarget.style.opacity = '0.75';
                  }}
                >
                  <img
                    src={imgSrc}
                    alt={`Thumbnail ${idx + 1}`}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      borderRadius: 6,
                    }}
                  />
                  {img.isPrimary && (
                    <div
                      style={{
                        position: 'absolute',
                        bottom: -2,
                        right: -2,
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        background: '#10b981',
                        border: '2px solid #fff',
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Add Image URL Manually */}
      <div style={{ marginTop: 4, borderTop: '1px solid #f3f4f6', paddingTop: 10 }}>
        <label
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#374151',
            display: 'block',
            marginBottom: 6,
          }}
        >
          Add Image URL Manually
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="https://example.com/image.jpg"
            value={manualImageUrl}
            onChange={(e) => setManualImageUrl(e.target.value)}
            style={{
              flex: 1,
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: 13,
              boxSizing: 'border-box',
              minHeight: 36,
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (manualImageUrl.trim()) {
                onAddManualUrl(manualImageUrl.trim());
                setManualImageUrl('');
              }
            }}
            style={{
              padding: '8px 16px',
              minHeight: 36,
              fontSize: 12,
              fontWeight: 600,
              background: '#7c3aed',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              transition: 'background-color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#6d28d9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#7c3aed';
            }}
          >
            Add URL
          </button>
        </div>
      </div>
    </div>
  );
}
