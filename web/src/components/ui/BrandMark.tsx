import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const brandMarkVariants = cva('shrink-0 text-accent', {
  variants: {
    size: {
      sm: 'h-5 w-5',
      md: 'h-8 w-8',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

type BrandMarkProps = VariantProps<typeof brandMarkVariants> & {
  className?: string;
};

export function BrandMark({ size, className }: BrandMarkProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 32 32"
      className={cn(brandMarkVariants({ size }), className)}
    >
      <path
        fill="currentColor"
        d="M16 7.5c.65 4.92 3.58 7.85 8.5 8.5-4.92.65-7.85 3.58-8.5 8.5-.65-4.92-3.58-7.85-8.5-8.5 4.92-.65 7.85-3.58 8.5-8.5Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        d="M4.5 9V4.5H9M23 4.5h4.5V9M27.5 23v4.5H23M9 27.5H4.5V23"
        opacity="0.7"
      />
    </svg>
  );
}
