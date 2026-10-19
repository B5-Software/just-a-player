import { AnimatePresence, motion } from 'motion/react'
/** Track changes crossfade; first mount has no entrance animation. */
export function CoverFade({
  src,
  className = ''
}: {
  src: string
  className?: string
}): React.JSX.Element {
  return (
    <AnimatePresence initial={false}>
      <motion.img
        key={src}
        src={src}
        alt=""
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.8, ease: 'easeInOut' }}
        className={`absolute inset-0 size-full object-cover ${className}`}
      />
    </AnimatePresence>
  )
}
