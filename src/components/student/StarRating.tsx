'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';

export default function StarRating({
  value,
  onChange,
  readonly = false,
}: {
  value: number;
  onChange?: (v: number) => void;
  readonly?: boolean;
}) {
  const [hovered, setHovered] = useState(0);

  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = readonly ? star <= value : star <= (hovered || value);
        return (
          <button
            key={star}
            type="button"
            disabled={readonly}
            onClick={() => !readonly && onChange?.(star)}
            onMouseEnter={() => !readonly && setHovered(star)}
            onMouseLeave={() => !readonly && setHovered(0)}
            className="leading-none focus:outline-none"
            style={{ cursor: readonly ? 'default' : 'pointer' }}
          >
            <Star
              size={24}
              fill={filled ? '#FF8303' : 'none'}
              stroke={filled ? '#FF8303' : '#9ca3af'}
            />
          </button>
        );
      })}
    </div>
  );
}
