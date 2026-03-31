'use client'

import { useState } from 'react'
import { signIn } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setError(null)
    setLoading(true)

    const result = await signIn(formData)

    // signIn either redirects on success, or returns an error object
    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#E0DFDC]">
      <Card className="w-full max-w-md shadow-lg border-0">
        <CardHeader className="text-center pb-2 pt-8">

          {/* Logo placeholder — swap this out when Shannon supplies the SVG */}
          <div className="flex justify-center mb-6">
            <div className="text-2xl font-bold text-[#FF8303] tracking-tight">
              LinguaLink Online
            </div>
          </div>

          <h1 className="text-xl font-semibold text-black">
            Teacher Portal
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Sign in to your account
          </p>
        </CardHeader>

        <CardContent className="px-8 pb-8 pt-4">
          <form action={handleSubmit} className="space-y-4">

            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@lingualinkonline.com"
                required
                autoComplete="email"
                className="h-10"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="••••••••"
                required
                autoComplete="current-password"
                className="h-10"
              />
            </div>

            {/* Only shows if login fails */}
            {error && (
              <p className="text-sm text-[#FD5602] bg-red-50 px-3 py-2 rounded-md">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-10 bg-[#FF8303] hover:bg-[#e67300] text-white font-medium mt-2"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </Button>

          </form>

          <p className="text-center text-xs text-gray-400 mt-6">
            Forgot your password? Contact{' '}
            <span className="text-[#FF8303]">admin@lingualinkonline.com</span>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}