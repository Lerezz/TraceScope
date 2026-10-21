import { useEffect, useRef, useState } from 'react'

// 进入视口 reveal（一次性）
export function Reveal({ children, className = '', delay = 0 }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.classList.add('in-view')
          io.disconnect()
        }
      },
      { threshold: 0.12 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div ref={ref} className={`reveal ${className}`} style={delay ? { transitionDelay: `${delay}s` } : undefined}>
      {children}
    </div>
  )
}

// 数字计数器（respect prefers-reduced-motion）
export function useCountUp(target, duration = 800) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce || target === 0) {
      setVal(target)
      return
    }
    let raf, t0
    const step = (t) => {
      if (!t0) t0 = t
      const p = Math.min((t - t0) / duration, 1)
      setVal(target * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return val
}
